import type { Context } from "@deepseek-ai/cordis";
import type {
  FileSystem,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { FsError } from "@deepseek-ai/dsh-fs";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  type DiffResultView,
  type FileDiff,
  type FileLocation,
  type ToolCallView,
  type ToolDefinition,
  type JsonSchemaNode,
  type ToolResult,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { scopeTarget } from "@deepseek-ai/dsh-scope";
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_NAME,
  DEFAULT_MAX_PATCH_CHARS,
  DEFAULT_MAX_PATCH_FILE_BYTES,
  DEFAULT_MAX_PATCH_FILES,
} from "../constants.js";
import { applyChunks } from "./matcher.js";
import { PatchError, patchErrorMessage } from "./errors.js";
import { parsePatch } from "./parser.js";
import type { ParsedPatch, PatchOperation, PresentationDiff } from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApplyPatchLimits {
  readonly maxPatchChars: number;
  readonly maxPatchFiles: number;
  readonly maxPatchFileBytes: number;
}

export const DEFAULT_APPLY_PATCH_LIMITS: ApplyPatchLimits = {
  maxPatchChars: DEFAULT_MAX_PATCH_CHARS,
  maxPatchFiles: DEFAULT_MAX_PATCH_FILES,
  maxPatchFileBytes: DEFAULT_MAX_PATCH_FILE_BYTES,
};

const EDIT_TOOL_NAMES = new Set(["edit", "write"]);

export interface ApplyPatchServices {
  readonly fs: FileSystem;
  readonly ctx: Context;
}

interface StagedOperation {
  readonly operation: PatchOperation;
  readonly target: FsTarget;
  readonly before: string | null;
  readonly after: string;
  readonly expected: FsWriteIntent;
}

export type PatchOperationStatus = "committed" | "failed" | "unattempted";

export interface PatchOperationOutcome {
  readonly path: string;
  readonly action: "add" | "update";
  readonly status: PatchOperationStatus;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ApplyPatchOutcome {
  readonly status: "applied" | "partial" | "failed" | "cancelled";
  readonly summary: string;
  readonly diff: string;
  readonly operations: PatchOperationOutcome[];
  readonly diffs: PresentationDiff[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface PatchProgress {
  readonly outcome: ApplyPatchOutcome;
}

type PatchExecution = Pick<ToolRunContext, "agent" | "signal">;

function workspaceCwd(exec: PatchExecution): string {
  const cwd = exec.agent?.session?.header?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new PatchError(
      "apply_patch requires an active Agent workspace",
      "PATCH_PATH_INVALID",
    );
  }
  return cwd;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseArguments(value: unknown, limits: ApplyPatchLimits): string {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PatchError(
      "apply_patch expects an object containing one non-empty patch string",
      "PATCH_INVALID",
    );
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "patch") ||
    typeof record.patch !== "string" ||
    record.patch.length === 0
  )
    throw new PatchError(
      "apply_patch expects an object containing one non-empty patch string",
      "PATCH_INVALID",
    );
  if (record.patch.length > limits.maxPatchChars)
    throw new PatchError(
      `apply_patch input exceeds the ${limits.maxPatchChars}-character limit`,
      "PATCH_TOO_LARGE",
    );
  return record.patch;
}

function operationAction(operation: PatchOperation): "add" | "update" {
  return operation.kind;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return "PATCH_IO";
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    errorCode(error) === "FS_ABORTED" ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function observeVersion(
  services: ApplyPatchServices,
  target: FsTarget,
  version: FsWriteOutcome["version"],
  exec: PatchExecution,
): void {
  services.ctx.emit(
    scopeTarget(services.fs, exec.agent),
    "fs/observed",
    target,
    { kind: "present", version },
    exec,
  );
}

async function writeIntent(
  services: ApplyPatchServices,
  target: FsTarget,
  fallback: FsWriteIntent,
  exec: PatchExecution,
): Promise<FsWriteIntent> {
  const intent = await services.ctx.waterfall(
    scopeTarget(services.fs, exec.agent),
    "fs/write-intent",
    target,
    exec,
    () => Promise.resolve(fallback),
  );
  return intent ?? fallback;
}

async function editIntent(
  services: ApplyPatchServices,
  target: FsTarget,
  fallback: { readonly version: FsInfo["version"] },
  exec: PatchExecution,
): Promise<{ readonly version: FsInfo["version"] }> {
  const intent = await services.ctx.waterfall(
    scopeTarget(services.fs, exec.agent),
    "fs/edit-intent",
    target,
    exec,
    () => Promise.resolve(fallback),
  );
  return intent ?? fallback;
}

function checkFileSize(
  info: FsInfo,
  path: string,
  limits: ApplyPatchLimits,
): void {
  if (info.size !== undefined && info.size > limits.maxPatchFileBytes)
    throw new PatchError(
      `apply_patch target '${path}' exceeds the ${limits.maxPatchFileBytes}-byte limit`,
      "PATCH_TOO_LARGE",
    );
}

async function preflight(
  patch: ParsedPatch,
  services: ApplyPatchServices,
  exec: PatchExecution,
  limits: ApplyPatchLimits,
): Promise<StagedOperation[]> {
  if (patch.operations.length > limits.maxPatchFiles)
    throw new PatchError(
      `apply_patch contains more than ${limits.maxPatchFiles} file operations`,
      "PATCH_TOO_LARGE",
    );
  const cwd = workspaceCwd(exec);
  const workspace = await services.fs.resolve(cwd, {
    cwd,
    signal: exec.signal,
  });
  const targets = new Map<unknown, string>();
  const staged: StagedOperation[] = [];

  for (const operation of patch.operations) {
    exec.signal.throwIfAborted();
    if (operation.path.trim().length === 0)
      throw new PatchError(
        `apply_patch ${operation.kind === "add" ? "Add" : "Update"} File path cannot be blank`,
        "PATCH_PATH_INVALID",
        { line: operation.line },
      );
    const target = await services.fs.resolve(operation.path, {
      cwd,
      signal: exec.signal,
    });
    exec.signal.throwIfAborted();
    if (!services.fs.contains(workspace, target))
      throw new PatchError(
        `apply_patch target '${operation.path}' must stay inside the active workspace`,
        "PATCH_PATH_INVALID",
        { line: operation.line },
      );
    const previousPath = targets.get(target.targetKey);
    if (previousPath !== undefined)
      throw new PatchError(
        `apply_patch contains duplicate target '${operation.path}' (same target as '${previousPath}')`,
        "PATCH_INVALID",
        { line: operation.line },
      );
    targets.set(target.targetKey, operation.path);

    const info = await services.fs.stat(target, exec.signal);
    exec.signal.throwIfAborted();
    if (operation.kind === "add") {
      if (info !== undefined)
        throw new PatchError(
          `apply_patch cannot add '${operation.path}': the target already exists`,
          "PATCH_INVALID",
          { line: operation.line },
        );
      if (byteLength(operation.content) > limits.maxPatchFileBytes)
        throw new PatchError(
          `apply_patch added file '${operation.path}' exceeds the ${limits.maxPatchFileBytes}-byte limit`,
          "PATCH_TOO_LARGE",
          { line: operation.line },
        );
      const expected = await writeIntent(
        services,
        target,
        { kind: "createIfAbsent" },
        exec,
      );
      if (expected.kind !== "createIfAbsent")
        throw new FsError(
          `cannot add '${operation.path}': the target changed after its absence was observed`,
          "FS_STALE_VERSION",
        );
      staged.push({
        operation,
        target,
        before: null,
        after: operation.content,
        expected,
      });
      continue;
    }

    if (info === undefined)
      throw new PatchError(
        `apply_patch cannot update '${operation.path}': the target does not exist`,
        "PATCH_INVALID",
        { line: operation.line },
      );
    if (info.type !== "file")
      throw new PatchError(
        `apply_patch cannot update '${operation.path}': the target is not a regular text file`,
        "PATCH_INVALID",
        { line: operation.line },
      );
    const edit = await editIntent(
      services,
      target,
      { version: info.version },
      exec,
    );
    if (edit.version !== info.version)
      throw new FsError(
        `cannot update '${operation.path}': the target changed after preflight stat`,
        "FS_STALE_VERSION",
      );
    const expected = await writeIntent(
      services,
      target,
      { kind: "replaceIfVersion", version: edit.version },
      exec,
    );
    if (
      expected.kind !== "replaceIfVersion" ||
      expected.version !== info.version
    )
      throw new FsError(
        `cannot update '${operation.path}': the target is not observed at its current version`,
        "FS_STALE_VERSION",
      );
    checkFileSize(info, operation.path, limits);
    const before = await services.fs.readText(target, exec.signal);
    exec.signal.throwIfAborted();
    if (byteLength(before) > limits.maxPatchFileBytes)
      throw new PatchError(
        `apply_patch target '${operation.path}' exceeds the ${limits.maxPatchFileBytes}-byte limit`,
        "PATCH_TOO_LARGE",
        { line: operation.line },
      );
    const after = applyChunks(before, operation.path, operation.chunks);
    if (byteLength(after) > limits.maxPatchFileBytes)
      throw new PatchError(
        `apply_patch updated file '${operation.path}' exceeds the ${limits.maxPatchFileBytes}-byte limit`,
        "PATCH_TOO_LARGE",
        { line: operation.line },
      );
    staged.push({
      operation,
      target,
      before,
      after,
      expected,
    });
    exec.signal.throwIfAborted();
  }
  return staged;
}

function operationSummary(
  operations: readonly PatchOperationOutcome[],
  status: ApplyPatchOutcome["status"],
): string {
  const committed = operations
    .filter((operation) => operation.status === "committed")
    .map((operation) => operation.path);
  const failed = operations.find((operation) => operation.status === "failed");
  const unattempted = operations
    .filter((operation) => operation.status === "unattempted")
    .map((operation) => operation.path);
  if (status === "applied")
    return `Applied patch to ${committed.length} file${committed.length === 1 ? "" : "s"}: ${committed.join(", ")}.`;
  const prefix =
    status === "cancelled"
      ? "Patch publication cancelled"
      : "Patch publication failed";
  const details = [`${prefix}.`];
  if (committed.length > 0) details.push(`Committed: ${committed.join(", ")}.`);
  if (failed !== undefined) details.push(`Failed: ${failed.path}.`);
  if (unattempted.length > 0)
    details.push(`Unattempted: ${unattempted.join(", ")}.`);
  return details.join(" ");
}

function unifiedDiff(diff: PresentationDiff): string {
  const oldLines = diff.oldText === null ? [] : diff.oldText.split("\n");
  const newLines = diff.newText.split("\n");
  return [
    `--- ${diff.oldText === null ? "/dev/null" : `a/${diff.path}`}`,
    `+++ b/${diff.path}`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function diffFromWrite(
  staged: StagedOperation,
  outcome: FsWriteOutcome,
): PresentationDiff {
  return {
    path: staged.operation.path,
    oldText: outcome.before ?? staged.before,
    newText: outcome.after,
  };
}

function outputFor(
  status: ApplyPatchOutcome["status"],
  operations: PatchOperationOutcome[],
  diffs: PresentationDiff[],
  failure?: { code: string; message: string },
): ApplyPatchOutcome {
  return {
    status,
    summary: operationSummary(operations, status),
    diff: diffs.map(unifiedDiff).join("\n"),
    operations,
    diffs,
    ...(failure === undefined ? {} : { error: failure }),
  };
}

/**
 * Preflight and publish a supported Codex patch through the DSH filesystem.
 *
 * Every operation is resolved, observed, read, matched, and calculated before
 * the first guarded atomic write. Publication is ordered and intentionally
 * non-transactional: a later failure leaves committed earlier files in place
 * and returns their diffs with explicit per-operation progress.
 */
export async function applyPatchToFileSystem(
  input: string,
  services: ApplyPatchServices,
  exec: PatchExecution,
  limits: ApplyPatchLimits = DEFAULT_APPLY_PATCH_LIMITS,
): Promise<ApplyPatchOutcome> {
  if (input.length > limits.maxPatchChars)
    throw new PatchError(
      `apply_patch input exceeds the ${limits.maxPatchChars}-character limit`,
      "PATCH_TOO_LARGE",
    );
  const parsed = parsePatch(input);
  const staged = await preflight(parsed, services, exec, limits);
  const operations: PatchOperationOutcome[] = staged.map(({ operation }) => ({
    path: operation.path,
    action: operationAction(operation),
    status: "unattempted",
  }));
  const diffs: PresentationDiff[] = [];

  for (const [index, candidate] of staged.entries()) {
    let writeStarted = false;
    try {
      exec.signal.throwIfAborted();
      writeStarted = true;
      const write = await services.fs.writeText(
        candidate.target,
        candidate.after,
        candidate.expected,
        exec.signal,
      );
      const operation = operations[index];
      if (operation === undefined)
        throw new Error("patch operation disappeared");
      operations[index] = { ...operation, status: "committed" };
      diffs.push(diffFromWrite(candidate, write));
      observeVersion(services, candidate.target, write.version, exec);
    } catch (error) {
      const code = isCancellation(error, exec.signal)
        ? "FS_ABORTED"
        : errorCode(error);
      const message = isCancellation(error, exec.signal)
        ? "patch publication was cancelled"
        : patchErrorMessage(error);
      const operation = operations[index];
      if (operation !== undefined && writeStarted)
        operations[index] = {
          ...operation,
          status: "failed",
          error: { code, message },
        };
      return outputFor(
        isCancellation(error, exec.signal)
          ? "cancelled"
          : diffs.length > 0
            ? "partial"
            : "failed",
        operations,
        diffs,
        { code, message },
      );
    }
  }
  return outputFor("applied", operations, diffs);
}

function outcomeText(outcome: ApplyPatchOutcome): string {
  const error = outcome.error;
  return [
    outcome.summary,
    error === undefined ? "" : `Error (${error.code}): ${error.message}`,
    outcome.diff.length === 0 ? "" : `\n${outcome.diff}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderOutcome(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: outcomeText(value as ApplyPatchOutcome) }];
}

function presentationDiffs(value: unknown): FileDiff[] {
  const outcome = value as ApplyPatchOutcome;
  return outcome.diffs.map((diff) => ({
    path: diff.path,
    oldText: diff.oldText,
    newText: diff.newText,
  }));
}

function isDiffResultMeta(value: unknown): value is { diffs: FileDiff[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const diffs = (value as Record<string, unknown>).diffs;
  return (
    Array.isArray(diffs) &&
    diffs.every(
      (diff) =>
        typeof diff === "object" &&
        diff !== null &&
        typeof (diff as Record<string, unknown>).path === "string" &&
        typeof (diff as Record<string, unknown>).newText === "string",
    )
  );
}

function callView(args: unknown, limits: ApplyPatchLimits): ToolCallView {
  try {
    const patch = parseArguments(args, limits);
    const parsed = parsePatch(patch);
    const locations: FileLocation[] = parsed.operations.map((operation) => ({
      path: operation.path,
    }));
    return {
      card: "generic",
      title: `Apply patch (${locations.length} file${locations.length === 1 ? "" : "s"})`,
      kind: "edit",
      rawInput: patch,
      locations,
    };
  } catch {
    return {
      card: "generic",
      title: "Apply patch",
      kind: "edit",
      rawInput: args,
    };
  }
}

function resultView(
  _args: unknown,
  result: ToolResult,
): DiffResultView | undefined {
  if (!result.isError && isDiffResultMeta(result.meta)) {
    return { card: "diff", diffs: result.meta.diffs };
  }
  return undefined;
}

const parameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    patch: {
      type: "string",
      description: "Complete raw Codex Add File/Update File patch text.",
    },
  },
  required: ["patch"],
} as const;

const outputSchema: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["applied", "partial", "failed", "cancelled"],
    },
    summary: { type: "string" },
    diff: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["add", "update"] },
          status: {
            type: "string",
            enum: ["committed", "failed", "unattempted"],
          },
          error: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
        },
        required: ["path", "action", "status"],
      },
    },
    diffs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          oldText: {
            oneOf: [{ type: "string" }, { type: "null" }],
          },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
      required: ["code", "message"],
    },
  },
  required: ["status", "summary", "diff", "operations", "diffs"],
} as const;

/** Build the registry definition for the direct raw patch tool. */
export function createApplyPatchTool(
  services: ApplyPatchServices,
  progressByExecution: WeakMap<object, PatchProgress>,
  limits: ApplyPatchLimits = DEFAULT_APPLY_PATCH_LIMITS,
): ToolDefinition {
  return {
    name: APPLY_PATCH_NAME,
    description: APPLY_PATCH_DESCRIPTION,
    parameters,
    output: {
      schema: outputSchema,
      render: renderOutcome,
      presentationMeta: (_args, value): JsonValue => ({
        diffs: presentationDiffs(value).map((diff) => ({
          path: diff.path,
          oldText: diff.oldText,
          newText: diff.newText,
        })),
      }),
    },
    async execute(args, exec) {
      const patch = parseArguments(args, limits);
      const outcome = await applyPatchToFileSystem(
        patch,
        services,
        exec,
        limits,
      );
      progressByExecution.set(exec, { outcome });
      return outcome;
    },
    finalizeContent(exec, result) {
      const progress = progressByExecution.get(exec);
      progressByExecution.delete(exec);
      if (progress === undefined || !result.isError) return undefined;
      return renderOutcome(exec.arguments, progress.outcome);
    },
    presentCall: (args) => callView(args, limits),
    presentResult: resultView,
  };
}

export { EDIT_TOOL_NAMES };
