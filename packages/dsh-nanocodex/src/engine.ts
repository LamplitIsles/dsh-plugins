import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from "@deepseek-ai/dsh-compaction";
import {
  canonicalHeader,
  headerEquals,
  SessionSeq,
  type SessionId,
  type RequestContext,
  type Session,
} from "@deepseek-ai/dsh-session";
import {
  defineDomain,
  domainTable,
  type KvTable,
} from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import {
  createToolResultMessage,
  ToolCallId,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type ToolSchema,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  renderPrompt,
  type PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";
import type {
  PtcDispatchEventData,
  PtcDispatchStartEventData,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import {
  Agent as NodeAgent,
  createQuickJsEvaluator,
  Transport,
  type AgentEvent,
  type CodeEvaluator,
  type CompactionInstructionContext,
  type CompactionItemIdentity,
  type CompactionOutcome,
  type CompactionReplacedEventPayload,
  type HistoryItem,
  type ToolDefinition as NanocodexToolDefinition,
  type SessionSnapshot,
} from "nanocodex/node";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
  APPLY_PATCH_NAME,
  isSupportedModel,
  MODEL_CONTEXT_WINDOW,
  type NanocodexModel,
} from "./constants.js";
import {
  buildHistoryProjection,
  buildHistorySeed,
  buildPromptInput,
  historyToolCallId,
  plainText,
} from "./history.js";
import { normalizeNanocodexSessionId } from "./session-id.js";
import {
  resolveNanocodexRoute,
  type ResolvedNanocodexRoute,
  type SettingsContext,
} from "./settings.js";
import { createToolBridge, type ToolBridge } from "./tool-bridge.js";
import { NanocodexOutput } from "./output.js";
import { observeTransportFallback } from "./transport-diagnostic.js";

interface ActiveTurn {
  readonly output: NanocodexOutput;
  readonly drain: () => Promise<void>;
}

export interface NanocodexCompactionResult {
  readonly summary: string;
  readonly outcome: CompactionOutcome;
  readonly selection: NanocodexCompactionSelection;
  /** The engine-owned checkpoint captured immediately after installation. */
  readonly snapshot: SessionSnapshot;
  readonly provider: string;
  readonly model: NanocodexModel;
}

export interface NanocodexAutomaticCompaction {
  readonly outcome: CompactionOutcome;
  readonly phase: CompactionReplacedEventPayload["phase"];
  readonly afterModelCallIndex: number;
  /** DSH surface nodes admitted to the engine at this compaction boundary. */
  readonly admittedSurfaceSeqs: readonly SessionSeq[];
}

type NanocodexCompactionMappingBoundary = Pick<
  NanocodexAutomaticCompaction,
  "phase" | "afterModelCallIndex" | "admittedSurfaceSeqs"
>;

export interface NanocodexCompactionSelection {
  readonly shadowedRange: {
    readonly start: SessionSeq;
    readonly end: SessionSeq;
  };
  readonly shadowedSeqs: readonly SessionSeq[];
}

export interface EngineRunResult {
  readonly provider: string;
  readonly model: NanocodexModel;
  /** The exact public Nanocodex snapshot at the successful DSH boundary. */
  readonly snapshot: SessionSnapshot;
  /**
   * Nanocodex may compact its private model context during a normal turn. The
   * adapter projects the validated private checkpoint into DSH only after the
   * turn has completed successfully.
   */
  readonly automaticCompactions: readonly NanocodexAutomaticCompaction[];
}

interface SurfaceBoundary {
  readonly replaceGeneration: number;
  readonly surfaceSeqs: readonly SessionSeq[];
  readonly messageCount: number;
  readonly fingerprint: string;
}

export interface NanocodexCheckpoint {
  readonly version: 1;
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly boundary: SurfaceBoundary;
  readonly snapshot: SessionSnapshot;
}

export type NanocodexCheckpointStore = Pick<
  KvTable<SessionId, NanocodexCheckpoint>,
  "get" | "put"
>;

export const nanocodexCheckpointDomain = defineDomain({
  name: "nanocodex_checkpoints",
  version: 1,
  layout: "per-record",
  tables: {
    sessions: domainTable<SessionId, NanocodexCheckpoint>(
      z.custom<NanocodexCheckpoint>((value) => checkpoint(value) !== undefined),
    ),
  },
});

type NodeAgentHandle = Awaited<ReturnType<typeof NodeAgent.create>>;

interface LiveRuntime {
  readonly agent: Agent;
  readonly nodeAgent: NodeAgentHandle;
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly routeKey: string;
  readonly system: string;
  readonly toolKey: string;
  readonly bridge: ToolBridge;
  active?: ActiveTurn | undefined;
  boundary?: SurfaceBoundary;
  readonly consumedCompactionRevisions: Set<string>;
}

const RAW_APPLICATION_DEFINITIONS: ReadonlyMap<
  string,
  NanocodexToolDefinition
> = new Map([
  [
    APPLY_PATCH_NAME,
    {
      type: "custom",
      description: APPLY_PATCH_DESCRIPTION,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: APPLY_PATCH_GRAMMAR,
      },
    },
  ],
]);

// Compaction and controller seams carry the stable DSH Session even when the
// Agent handle itself is replaced or wrapped during Host routing.
function runtimeKey(agent: Agent): string {
  return String(agent.session.id);
}

function messageText(message: UserMessage): string {
  return plainText([message]);
}

function supplementaryContext(
  messages: readonly UserMessage[],
): string | undefined {
  const context = messages
    .filter((message) => message.source.kind === "plugin")
    .map(messageText)
    .filter(Boolean)
    .join("\n\n");
  return context || undefined;
}

function routeKey(route: ResolvedNanocodexRoute, agent: Agent): string {
  // This value is process-local only. In particular, the credential is never
  // included in a DSH event or a diagnostic message; its digest makes a
  // credential rotation force a new provider transport for the retained host.
  return JSON.stringify({
    provider: route.provider,
    model: route.model,
    apiKeyDigest: createHash("sha256").update(route.apiKey).digest("hex"),
    apiBaseUrl: route.apiBaseUrl,
    websocketUrl: route.websocketUrl,
    thinking: route.thinking,
    reasoningEffort: agent.options.reasoningEffort,
  });
}

function fingerprint(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function makeBoundary(
  session: Session,
  messages: readonly Message[],
): SurfaceBoundary {
  return {
    replaceGeneration: session.surface.replaceGeneration,
    surfaceSeqs: [...session.surface.nodes],
    messageCount: messages.length,
    fingerprint: fingerprint(messages),
  };
}

function boundaryMatches(
  boundary: SurfaceBoundary,
  session: Session,
  messages: readonly Message[],
): boolean {
  const nodes = session.surface.nodes;
  return (
    boundary.replaceGeneration === session.surface.replaceGeneration &&
    boundary.messageCount === messages.length &&
    boundary.surfaceSeqs.length <= nodes.length &&
    boundary.surfaceSeqs.every((seq, index) => nodes[index] === seq) &&
    boundary.fingerprint === fingerprint(messages)
  );
}

function surfacePrefix(
  session: Session,
  messageCount: number,
): readonly SessionSeq[] {
  const nodes = [...session.surface.nodes];
  if (messageCount > nodes.length) {
    throw new Error(
      "Nanocodex compaction cannot capture a DSH admission boundary",
    );
  }
  return nodes.slice(0, messageCount);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function supportedModel(value: unknown): NanocodexModel | undefined {
  return typeof value === "string" && isSupportedModel(value)
    ? value
    : undefined;
}

function sessionSnapshot(value: unknown): SessionSnapshot | undefined {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.history)) return undefined;
  if (supportedModel(candidate.model) === undefined) return undefined;
  return candidate as unknown as SessionSnapshot;
}

function checkpoint(value: unknown): NanocodexCheckpoint | undefined {
  const candidate = record(value);
  const boundary = record(candidate?.boundary);
  const snapshot = sessionSnapshot(candidate?.snapshot);
  if (
    candidate?.version !== 1 ||
    typeof candidate.provider !== "string" ||
    supportedModel(candidate.model) === undefined ||
    !boundary ||
    snapshot === undefined ||
    snapshot.model !== candidate.model ||
    !Array.isArray(boundary.surfaceSeqs) ||
    !boundary.surfaceSeqs.every(
      (seq): seq is SessionSeq =>
        typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0,
    ) ||
    typeof boundary.replaceGeneration !== "number" ||
    !Number.isSafeInteger(boundary.replaceGeneration) ||
    boundary.replaceGeneration < 0 ||
    typeof boundary.messageCount !== "number" ||
    !Number.isSafeInteger(boundary.messageCount) ||
    boundary.messageCount < 0 ||
    typeof boundary.fingerprint !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    provider: candidate.provider,
    model: supportedModel(candidate.model)!,
    boundary: {
      replaceGeneration: boundary.replaceGeneration,
      surfaceSeqs: boundary.surfaceSeqs,
      messageCount: boundary.messageCount,
      fingerprint: boundary.fingerprint,
    },
    snapshot,
  };
}

function findMatchingCheckpoint(
  store: NanocodexCheckpointStore,
  session: Session,
  messages: readonly Message[],
  provider: string,
  model: NanocodexModel,
): NanocodexCheckpoint | undefined {
  const candidate = checkpoint(store.get(session.id));
  if (
    candidate !== undefined &&
    candidate.provider === provider &&
    candidate.model === model &&
    boundaryMatches(candidate.boundary, session, messages)
  ) {
    return candidate;
  }
  return undefined;
}

const DEFAULT_COMPACTION_INSTRUCTION = [
  "Create a concise private continuity summary of the conversation above.",
  "Preserve important facts, preferences, commitments, unresolved questions, and the immediate context.",
  "Return summary text only. Do not mention this instruction or compaction.",
].join("\n");

async function* emptyLlmStream(): AsyncGenerator<never, void, void> {}

interface SurfaceHistoryItem {
  readonly surfaceIndex: number;
  readonly message: Message;
  readonly item: HistoryItem;
}

type PublicHistoryItem = HistoryItem;

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseCompactionIdentity(
  value: unknown,
): CompactionItemIdentity | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    !integer(candidate.index) ||
    typeof candidate.kind !== "string" ||
    candidate.kind.length === 0 ||
    !nullableString(candidate.id) ||
    !nullableString(candidate.call_id)
  ) {
    return undefined;
  }
  return candidate as unknown as CompactionItemIdentity;
}

function parseCompactionOutcome(value: unknown): CompactionOutcome | undefined {
  const candidate = record(value);
  const range = record(candidate?.replaced_history);
  const context = record(candidate?.context);
  const retained = Array.isArray(candidate?.retained_tail)
    ? candidate.retained_tail.map(parseCompactionIdentity)
    : undefined;
  if (
    !candidate ||
    typeof candidate.revision !== "string" ||
    candidate.revision.length === 0 ||
    (candidate.trigger !== "manual" && candidate.trigger !== "automatic") ||
    !nullableString(candidate.summary) ||
    !range ||
    !integer(range.start) ||
    !integer(range.end) ||
    range.start > range.end ||
    !retained ||
    retained.some((item): item is undefined => item === undefined) ||
    !context ||
    typeof context.workspace !== "string" ||
    !Array.isArray(context.history) ||
    !context.history.every((item) => record(item) !== undefined)
  ) {
    return undefined;
  }
  return candidate as unknown as CompactionOutcome;
}

function parseCompactionReplacedEvent(
  event: AgentEvent,
): CompactionReplacedEventPayload | undefined {
  if (event.type !== "model.compaction.replaced") return undefined;
  const outcome = parseCompactionOutcome(event.payload);
  if (
    outcome === undefined ||
    !integer(event.payload.after_model_call_index) ||
    (event.payload.phase !== "pre_turn" && event.payload.phase !== "mid_turn")
  ) {
    return undefined;
  }
  return event.payload as unknown as CompactionReplacedEventPayload;
}

function projectedIdentityMatches(
  identity: CompactionItemIdentity,
  item: PublicHistoryItem,
): boolean {
  const identityKind =
    identity.kind === "custom_tool_call"
      ? "function_call"
      : identity.kind === "custom_tool_call_output"
        ? "function_call_output"
        : identity.kind;
  const itemKind =
    item.type === "custom_tool_call"
      ? "function_call"
      : item.type === "custom_tool_call_output"
        ? "function_call_output"
        : item.type;
  if (identityKind !== itemKind) return false;
  const callId = "call_id" in item ? item.call_id : null;
  if (identity.call_id !== callId) return false;
  // Nanocodex may assign a new id to a retained message while preserving its
  // authoritative history index. Function-call identities have no such
  // replacement and remain exact.
  return (
    identityKind === "message" ||
    identityKind === "function_call" ||
    identityKind === "function_call_output" ||
    identity.id === (item.id ?? null)
  );
}

type HistoryImageDetail = "auto" | "low" | "high" | "original";

function historyImageDetail(
  value: unknown,
): value is HistoryImageDetail | undefined {
  return (
    value === undefined ||
    value === "auto" ||
    value === "low" ||
    value === "high" ||
    value === "original"
  );
}

function historyInputItemMatches(left: unknown, right: unknown): boolean {
  const leftObject = record(left);
  const rightObject = record(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  if (leftObject.type !== rightObject.type) return false;
  switch (leftObject.type) {
    case "input_text":
      return (
        typeof leftObject.text === "string" &&
        leftObject.text === rightObject.text
      );
    case "input_image":
      return (
        typeof leftObject.image_url === "string" &&
        leftObject.image_url === rightObject.image_url &&
        historyImageDetail(leftObject.detail) &&
        historyImageDetail(rightObject.detail) &&
        leftObject.detail === rightObject.detail
      );
    case "input_audio":
      return (
        typeof leftObject.audio_url === "string" &&
        leftObject.audio_url === rightObject.audio_url
      );
    case "encrypted_content":
      return (
        typeof leftObject.encrypted_content === "string" &&
        leftObject.encrypted_content === rightObject.encrypted_content
      );
    default:
      return false;
  }
}

function historyContentItemMatches(left: unknown, right: unknown): boolean {
  const leftObject = record(left);
  const rightObject = record(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  if (leftObject.type !== rightObject.type) return false;
  if (leftObject.type === "output_text") {
    return (
      typeof leftObject.text === "string" &&
      leftObject.text === rightObject.text
    );
  }
  if (
    leftObject.type === "input_text" ||
    leftObject.type === "input_image" ||
    leftObject.type === "input_audio"
  ) {
    return historyInputItemMatches(left, right);
  }
  return false;
}

function historyContentMatches(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((item, index) => historyContentItemMatches(item, right[index]))
  );
}

function historyToolOutputMatches(left: unknown, right: unknown): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return typeof left === "string" && left === right;
  }
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((item, index) => historyInputItemMatches(item, right[index]))
  );
}

function historyMessageMatches(
  left: PublicHistoryItem | undefined,
  right: HistoryItem,
): boolean {
  return (
    left?.type === "message" &&
    right.type === "message" &&
    left.role === right.role &&
    historyContentMatches(left.content, right.content)
  );
}

function historyItemsMatch(
  left: PublicHistoryItem | undefined,
  right: PublicHistoryItem,
): boolean {
  if (left === undefined) return false;
  const leftType = historyKind(left);
  const rightType = historyKind(right);
  if (leftType !== rightType) return false;
  switch (leftType) {
    case "message":
      return (
        left.type === "message" &&
        right.type === "message" &&
        left.role === right.role &&
        historyContentMatches(left.content, right.content)
      );
    case "function_call": {
      const leftCall = functionCallFields(left);
      const rightCall = functionCallFields(right);
      return (
        leftCall !== undefined &&
        rightCall !== undefined &&
        leftCall.name === rightCall.name &&
        leftCall.input === rightCall.input &&
        leftCall.call_id === rightCall.call_id
      );
    }
    case "function_call_output": {
      const leftOutput = functionCallOutputFields(left);
      const rightOutput = functionCallOutputFields(right);
      return (
        leftOutput !== undefined &&
        rightOutput !== undefined &&
        leftOutput.call_id === rightOutput.call_id &&
        historyToolOutputMatches(leftOutput.output, rightOutput.output)
      );
    }
    case "compaction":
      return (
        left.type === "compaction" &&
        right.type === "compaction" &&
        left.encrypted_content === right.encrypted_content
      );
    default:
      return false;
  }
}

function historyKind(item: PublicHistoryItem): string {
  if (item.type === "custom_tool_call") return "function_call";
  if (item.type === "custom_tool_call_output") return "function_call_output";
  return item.type;
}

function functionCallFields(
  item: PublicHistoryItem,
): { name: string; input: string; call_id: string } | undefined {
  if (item.type === "function_call") {
    return { name: item.name, input: item.arguments, call_id: item.call_id };
  }
  if (item.type === "custom_tool_call") {
    return { name: item.name, input: item.input, call_id: item.call_id };
  }
  return undefined;
}

function functionCallOutputFields(
  item: PublicHistoryItem,
): { call_id: string; output: unknown } | undefined {
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    return { call_id: item.call_id, output: item.output };
  }
  return undefined;
}

function validateRetainedApplyPatchPairs(
  items: readonly PublicHistoryItem[],
): ReadonlySet<string> {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const item of items) {
    if (item.type === "custom_tool_call" && item.name === APPLY_PATCH_NAME) {
      if (callIds.has(item.call_id)) {
        throw new Error(
          `Nanocodex compaction retained duplicate apply_patch call ${JSON.stringify(item.call_id)}`,
        );
      }
      callIds.add(item.call_id);
      continue;
    }
    if (item.type !== "custom_tool_call_output") continue;
    const namedPatch = item.name === APPLY_PATCH_NAME;
    const matchesPatchCall = callIds.has(item.call_id);
    if (!namedPatch && !matchesPatchCall) continue;
    if (!matchesPatchCall) {
      throw new Error(
        `Nanocodex compaction retained apply_patch output has no matching call ${JSON.stringify(item.call_id)}`,
      );
    }
    if (item.name !== undefined && item.name !== APPLY_PATCH_NAME) {
      throw new Error(
        `Nanocodex compaction retained apply_patch output has a mismatched name ${JSON.stringify(item.call_id)}`,
      );
    }
    if (resultIds.has(item.call_id)) {
      throw new Error(
        `Nanocodex compaction retained duplicate apply_patch output ${JSON.stringify(item.call_id)}`,
      );
    }
    resultIds.add(item.call_id);
  }
  for (const callId of callIds) {
    if (!resultIds.has(callId)) {
      throw new Error(
        `Nanocodex compaction retained apply_patch call without a result ${JSON.stringify(callId)}`,
      );
    }
  }
  return callIds;
}

interface CodeDispatchEvent<T> {
  readonly seq: SessionSeq;
  readonly data: T;
}

interface CodeDispatchState {
  readonly starts: CodeDispatchEvent<PtcDispatchStartEventData>[];
  readonly settles: CodeDispatchEvent<PtcDispatchEventData>[];
}

interface CodeDispatchChild {
  readonly startSeq: SessionSeq;
  readonly settleSeq: SessionSeq;
  readonly subCallId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly isError: boolean;
  readonly content: readonly ContentBlock[];
}

interface CodeDispatchAssociation {
  readonly children: CodeDispatchChild[];
  invalid: boolean;
}

function codeDispatchAssociations(
  session: Pick<Session, "snapshotEvents">,
): ReadonlyMap<string, CodeDispatchAssociation> {
  const bySubCallId = new Map<string, CodeDispatchState>();
  for (const event of session.snapshotEvents()) {
    if (
      event.type !== "tool/code-dispatch-start" &&
      event.type !== "tool/code-dispatch"
    ) {
      continue;
    }
    const subCallId = String(event.data.subCallId);
    const state = bySubCallId.get(subCallId) ?? {
      starts: [],
      settles: [],
    };
    if (event.type === "tool/code-dispatch-start") {
      state.starts.push({ seq: event.seq, data: event.data });
    } else {
      state.settles.push({ seq: event.seq, data: event.data });
    }
    bySubCallId.set(subCallId, state);
  }

  const associations = new Map<string, CodeDispatchAssociation>();
  const associationFor = (parentCallId: string): CodeDispatchAssociation => {
    const existing = associations.get(parentCallId);
    if (existing !== undefined) return existing;
    const created: CodeDispatchAssociation = { children: [], invalid: false };
    associations.set(parentCallId, created);
    return created;
  };

  for (const state of bySubCallId.values()) {
    const parentCallIds = new Set([
      ...state.starts.map((event) => String(event.data.parentCallId)),
      ...state.settles.map((event) => String(event.data.parentCallId)),
    ]);
    for (const parentCallId of parentCallIds) {
      const association = associationFor(parentCallId);
      const start = state.starts[0];
      const settle = state.settles[0];
      if (
        state.starts.length !== 1 ||
        state.settles.length !== 1 ||
        start === undefined ||
        settle === undefined ||
        String(start.data.parentCallId) !== parentCallId ||
        String(settle.data.parentCallId) !== parentCallId ||
        String(start.data.rootCallId) !== String(settle.data.rootCallId) ||
        settle.seq <= start.seq ||
        start.data.name !== settle.data.name ||
        !isDeepStrictEqual(start.data.arguments, settle.data.arguments)
      ) {
        association.invalid = true;
        continue;
      }
      association.children.push({
        startSeq: start.seq,
        settleSeq: settle.seq,
        subCallId: String(settle.data.subCallId),
        name: settle.data.name,
        arguments: settle.data.arguments,
        isError: settle.data.isError,
        content: settle.data.content,
      });
    }
  }
  for (const association of associations.values()) {
    association.children.sort((left, right) => left.startSeq - right.startSeq);
  }
  return associations;
}

interface DshToolEvidence {
  readonly calls: { readonly name: string; readonly arguments: string }[];
  readonly results: {
    readonly isError: boolean;
    readonly content: readonly ContentBlock[];
  }[];
}

function dshToolEvidence(
  session: Pick<Session, "snapshotEvents">,
): ReadonlyMap<string, DshToolEvidence> {
  const evidence = new Map<string, DshToolEvidence>();
  const forCall = (callId: string): DshToolEvidence => {
    const existing = evidence.get(callId);
    if (existing !== undefined) return existing;
    const created: DshToolEvidence = { calls: [], results: [] };
    evidence.set(callId, created);
    return created;
  };
  for (const event of session.snapshotEvents()) {
    if (event.type === "tool/call") {
      const callId = String(event.data.callId);
      forCall(callId).calls.push({
        name: event.data.name,
        arguments: event.data.arguments,
      });
    } else if (event.type === "tool/result") {
      const block = event.data.message.content[0];
      const callId = String(event.data.message.source.callId);
      forCall(callId).results.push({
        isError: block?.isError === true,
        content: block?.content ?? [],
      });
    }
  }
  return evidence;
}

function serializedToolArguments(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return undefined;
  }
}

function codeDispatchCallMatches(
  projected: readonly SurfaceHistoryItem[],
  projectedIndex: number,
  child: CodeDispatchChild,
  evidence: ReadonlyMap<string, DshToolEvidence>,
): boolean {
  const call = projected[projectedIndex]?.item;
  const callFields = call === undefined ? undefined : functionCallFields(call);
  const tool = evidence.get(child.subCallId);
  const expectedArguments = serializedToolArguments(child.arguments);
  const expectedInput =
    child.name === APPLY_PATCH_NAME
      ? (() => {
          try {
            const value = JSON.parse(serializedToolArguments(child.arguments)!);
            return value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              typeof (value as { patch?: unknown }).patch === "string" &&
              Object.keys(value).length === 1
              ? (value as { patch: string }).patch
              : undefined;
          } catch {
            return undefined;
          }
        })()
      : serializedToolArguments(child.arguments);
  return (
    (call?.type === "function_call" || call?.type === "custom_tool_call") &&
    callFields !== undefined &&
    callFields.call_id === historyToolCallId(child.subCallId) &&
    callFields.name === child.name &&
    expectedInput !== undefined &&
    callFields.input === expectedInput &&
    expectedArguments !== undefined &&
    tool !== undefined &&
    tool.calls.length === 1 &&
    tool.results.length === 1 &&
    tool.calls[0]!.name === child.name &&
    tool.calls[0]!.arguments === expectedArguments
  );
}

function codeDispatchResultMatches(
  projected: readonly SurfaceHistoryItem[],
  projectedIndex: number,
  child: CodeDispatchChild,
  evidence: ReadonlyMap<string, DshToolEvidence>,
): boolean {
  const output = projected[projectedIndex]?.item;
  const outputFields =
    output === undefined ? undefined : functionCallOutputFields(output);
  const tool = evidence.get(child.subCallId);
  return (
    (output?.type === "function_call_output" ||
      output?.type === "custom_tool_call_output") &&
    outputFields !== undefined &&
    outputFields.call_id === historyToolCallId(child.subCallId) &&
    tool !== undefined &&
    tool.calls.length === 1 &&
    tool.results.length === 1 &&
    tool.results[0]!.isError === child.isError &&
    isDeepStrictEqual(tool.results[0]!.content, child.content)
  );
}

interface CodeDispatchExpectation {
  readonly seq: SessionSeq;
  readonly kind: "call" | "result";
  readonly child: CodeDispatchChild;
}

function codeDispatchProjectedCount(
  projected: readonly SurfaceHistoryItem[],
  projectedIndex: number,
  association: CodeDispatchAssociation,
  evidence: ReadonlyMap<string, DshToolEvidence>,
): number {
  if (association.invalid || association.children.length === 0) {
    throw new Error(
      "Nanocodex compaction retained Code Mode child tool association is incomplete",
    );
  }
  const expectations = association.children
    .flatMap((child) => [
      { seq: child.startSeq, kind: "call" as const, child },
      { seq: child.settleSeq, kind: "result" as const, child },
    ])
    .sort((left, right) => left.seq - right.seq) as CodeDispatchExpectation[];
  let index = projectedIndex;
  for (const expectation of expectations) {
    const matches =
      expectation.kind === "call"
        ? codeDispatchCallMatches(projected, index, expectation.child, evidence)
        : codeDispatchResultMatches(
            projected,
            index,
            expectation.child,
            evidence,
          );
    if (!matches) {
      throw new Error(
        "Nanocodex compaction retained Code Mode child tool does not match the DSH pair",
      );
    }
    index += 1;
  }
  return index - projectedIndex;
}

function mergeSupplementaryContext(
  entries: readonly SurfaceHistoryItem[],
): HistoryItem | undefined {
  const first = entries[0];
  if (
    first === undefined ||
    first.item.type !== "message" ||
    first.item.role !== "user" ||
    first.message.role !== "user" ||
    first.message.source.kind !== "user"
  ) {
    return undefined;
  }
  const pluginMessages = entries.slice(1).map((entry) => entry.message);
  if (
    pluginMessages.some(
      (message) => message.role !== "user" || message.source.kind !== "plugin",
    )
  ) {
    return undefined;
  }
  const text = pluginMessages
    .map((message) => plainText([message]))
    .filter(Boolean)
    .join("\n\n");
  if (!text) return undefined;
  return {
    ...first.item,
    content: [...first.item.content, { type: "input_text", text }],
  };
}

function isRealUserHistoryItem(entry: SurfaceHistoryItem | undefined): boolean {
  return (
    entry !== undefined &&
    entry.item.type === "message" &&
    entry.item.role === "user" &&
    entry.message.role === "user" &&
    entry.message.source.kind === "user"
  );
}

function isPluginUserHistoryItem(
  entry: SurfaceHistoryItem | undefined,
): boolean {
  return (
    entry !== undefined &&
    entry.item.type === "message" &&
    entry.item.role === "user" &&
    entry.message.role === "user" &&
    entry.message.source.kind === "plugin"
  );
}

function supplementaryGroupEnd(
  projected: readonly SurfaceHistoryItem[],
  start: number,
): number {
  let end = start + 1;
  while (isPluginUserHistoryItem(projected[end])) end += 1;
  return end;
}

function projectedCountForContext(
  projected: readonly SurfaceHistoryItem[],
  projectedIndex: number,
  contextItem: PublicHistoryItem | undefined,
): number | undefined {
  const candidate = projected[projectedIndex];
  if (candidate === undefined || contextItem === undefined) return undefined;
  if (!isRealUserHistoryItem(candidate)) {
    return historyItemsMatch(contextItem, candidate.item) ? 1 : undefined;
  }

  const groupEnd = supplementaryGroupEnd(projected, projectedIndex);
  const merged = mergeSupplementaryContext(
    projected.slice(projectedIndex, groupEnd),
  );
  if (merged !== undefined && historyMessageMatches(contextItem, merged)) {
    return groupEnd - projectedIndex;
  }
  return historyItemsMatch(contextItem, candidate.item) ? 1 : undefined;
}

/** The only provider-facing owner in the DSH Nanocodex package. */
export class NanocodexEngine {
  private quickJsPromise: Promise<CodeEvaluator> | undefined;
  private readonly requestSurfaceGeneration = new WeakMap<Session, number>();
  private readonly runtimes = new Map<string, LiveRuntime>();

  constructor(
    private readonly ctx: Context,
    private readonly checkpoints: NanocodexCheckpointStore,
  ) {}

  private quickJs(): Promise<CodeEvaluator> {
    this.quickJsPromise ??= (async () => {
      const asyncQuickJsVariant = (
        await import("@jitl/quickjs-wasmfile-release-asyncify")
      ).default as unknown as Parameters<
        typeof newQuickJSAsyncWASMModuleFromVariant
      >[0];
      const quickJs =
        await newQuickJSAsyncWASMModuleFromVariant(asyncQuickJsVariant);
      return createQuickJsEvaluator(quickJs);
    })();
    return this.quickJsPromise;
  }

  async run(
    agent: Agent,
    previousMessages: readonly Message[],
    messages: readonly UserMessage[],
    assembly: PromptAssembly,
    turn: number,
    step: number,
    signal: AbortSignal,
    advanceStep: () => number,
  ): Promise<EngineRunResult> {
    signal.throwIfAborted();
    const route = await resolveNanocodexRoute(
      this.ctx as Context & SettingsContext,
      agent.options,
    );
    signal.throwIfAborted();
    const historySeed = await buildHistorySeed(
      previousMessages,
      this.ctx,
      signal,
    );
    const preTurnSurfaceSeqs = surfacePrefix(
      agent.session,
      previousMessages.length,
    );
    // Host-injected prompt context belongs to this admitted input through
    // Nanocodex's supplementaryContext seam. It must not become a second
    // synthetic user turn or be duplicated in the ordinary prompt payload.
    const input = await buildPromptInput(
      messages.filter((message) => message.source.kind !== "plugin"),
      this.ctx,
      signal,
    );
    const system = renderPrompt(assembly);
    const quickJs = await this.quickJs();
    signal.throwIfAborted();

    const output = new NanocodexOutput(
      agent,
      route.provider,
      route.model,
      turn,
      step,
      advanceStep,
    );
    let projection = Promise.resolve();
    const active: ActiveTurn = { output, drain: () => projection };
    const visibleToolNames = new Set(assembly.tools.map((tool) => tool.name));
    const toolKey = JSON.stringify(assembly.tools);
    const key = runtimeKey(agent);
    let runtime = this.runtimes.get(key);
    if (
      runtime !== undefined &&
      (runtime.agent !== agent ||
        runtime.routeKey !== routeKey(route, agent) ||
        runtime.system !== system ||
        runtime.toolKey !== toolKey ||
        runtime.boundary === undefined ||
        !boundaryMatches(runtime.boundary, agent.session, previousMessages))
    ) {
      await this.closeRuntime(runtime);
      this.runtimes.delete(key);
      runtime = undefined;
    }
    if (runtime === undefined) {
      const bridge = createToolBridge({
        tools: this.ctx.tools,
        agent,
        signal,
        customDefinitions: RAW_APPLICATION_DEFINITIONS,
        callbacks: {
          onCall: async ({
            id,
            name,
            arguments: argumentsText,
            parentCallId,
          }) => {
            const current = runtime?.active;
            if (current === undefined)
              throw new Error("Nanocodex tool call has no active DSH step");
            await current.drain();
            if (parentCallId !== undefined) return undefined;
            return agent.session.append("tool/call", {
              ...current.output.coordinates,
              callId: ToolCallId(id),
              name,
              arguments: argumentsText,
            }).seq;
          },
          onResult: async ({ id, callSeq, result }) => {
            const current = runtime?.active;
            if (current !== undefined) await current.drain();
            if (callSeq !== undefined) {
              const call = agent.session.eventAt(callSeq);
              if (call?.type !== "tool/call")
                throw new Error("Nanocodex tool result has no durable call");
              this.appendToolResult(
                agent,
                call.data.turn,
                call.data.step,
                id,
                callSeq,
                result,
              );
            }
            for (const context of result.additionalContexts ?? []) {
              agent.inject(context);
            }
          },
        },
      }).filter((tool) => visibleToolNames.has(tool.name));
      const checkpoint = findMatchingCheckpoint(
        this.checkpoints,
        agent.session,
        previousMessages,
        route.provider,
        route.model,
      );
      const nodeAgent = await this.createNodeAgent(
        agent,
        route,
        historySeed,
        system,
        bridge,
        quickJs,
        checkpoint?.snapshot,
      );
      runtime = {
        agent,
        nodeAgent,
        provider: route.provider,
        model: route.model,
        routeKey: routeKey(route, agent),
        system,
        toolKey,
        bridge,
        consumedCompactionRevisions: new Set(),
      };
      this.runtimes.set(key, runtime);
    }
    runtime.active = active;
    const automaticCompactions: NanocodexAutomaticCompaction[] = [];

    this.appendRequestFacts(
      agent,
      route.provider,
      route.model,
      agent.options.reasoningEffort,
      system,
      runtime.bridge,
    );
    const nodeAgent = runtime.nodeAgent;
    const watcher = nodeAgent.events.watch();
    const removeListener = watcher.onEvent((event) => {
      projection = projection.then(async () => {
        await output.accept(event);
        const replaced = parseCompactionReplacedEvent(event);
        if (
          replaced !== undefined &&
          replaced.trigger === "automatic" &&
          this.consumeCompactionOutcome(runtime, replaced)
        ) {
          automaticCompactions.push({
            outcome: replaced,
            phase: replaced.phase,
            afterModelCallIndex: replaced.after_model_call_index,
            admittedSurfaceSeqs:
              replaced.phase === "pre_turn"
                ? preTurnSurfaceSeqs
                : [...agent.session.surface.nodes],
          });
        }
      });
      // The event source cannot await listeners. Retain the error for drain()
      // and stop generation rather than accumulating an unrecordable turn.
      void projection.catch(() => modelTurn.cancel().catch(() => undefined));
    });
    const removeTransportFallback = observeTransportFallback(
      this.ctx,
      String(agent.id),
      nodeAgent,
    );
    const modelTurn = nodeAgent.turn.prompt({
      input,
      ...(supplementaryContext(messages)
        ? { supplementaryContext: supplementaryContext(messages) }
        : {}),
    });
    const abort = () => {
      void modelTurn.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    let discardRuntime = false;
    try {
      await modelTurn.accepted();
      const result = await modelTurn.result();
      try {
        await projection;
        signal.throwIfAborted();
        output.finish(result.finalMessage);
        const snapshot = await result.snapshot();
        return {
          provider: route.provider,
          model: route.model,
          snapshot,
          automaticCompactions,
        };
      } finally {
        result.dispose();
      }
    } catch (error) {
      discardRuntime = true;
      let failure = error;
      try {
        await projection;
      } catch (projectionError) {
        // Cancellation is a consequence of an unrecordable event. Preserve
        // the original failure so the user can act on the actual cause.
        failure = projectionError;
      }
      output.interrupt(failure);
      throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      removeListener();
      watcher.off();
      removeTransportFallback();
      modelTurn.dispose();
      runtime.active = undefined;
      if (discardRuntime) {
        this.runtimes.delete(key);
        await this.closeRuntime(runtime).catch(() => undefined);
      }
    }
  }

  /** Release the retained Nanocodex host after DSH has drained the Agent. */
  async dispose(agent: Agent): Promise<void> {
    const key = runtimeKey(agent);
    const runtime = this.runtimes.get(key);
    if (runtime === undefined) return;
    this.runtimes.delete(key);
    await this.closeRuntime(runtime);
  }

  /** Invalidate a runtime whose private context no longer matches DSH. */
  async invalidate(agent: Agent): Promise<void> {
    await this.dispose(agent);
  }

  /** Mark the retained runtime at the current authoritative DSH surface. */
  markSurfaceBoundary(agent: Agent): void {
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime !== undefined) {
      runtime.boundary = makeBoundary(
        agent.session,
        agent.session.deriveMessages(),
      );
    }
  }

  private consumeCompactionOutcome(
    runtime: LiveRuntime,
    outcome: CompactionOutcome,
  ): boolean {
    if (runtime.consumedCompactionRevisions.has(outcome.revision)) return false;
    runtime.consumedCompactionRevisions.add(outcome.revision);
    return true;
  }

  private runtimeFor(agent: Agent): LiveRuntime {
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime === undefined || runtime.agent !== agent) {
      throw new Error(
        "Nanocodex compaction requires the agent's current live runtime",
      );
    }
    return runtime;
  }

  /**
   * Map Nanocodex's exact retained-tail identities to the current DSH surface.
   * The engine owns the selection; DSH never guesses from a fixed message count.
   */
  async mapCompactionOutcome(
    agent: Pick<Agent, "session">,
    outcome: CompactionOutcome,
    signal: AbortSignal,
    mapping?: NanocodexCompactionMappingBoundary,
  ): Promise<NanocodexCompactionSelection> {
    signal.throwIfAborted();
    const range = outcome.replaced_history;
    const retained = outcome.retained_tail;
    if (
      range.start !== 0 ||
      range.end <= 0 ||
      retained.length === 0 ||
      retained[0]?.index !== range.end ||
      retained.some((item, index) => item.index !== range.end + index)
    ) {
      throw new Error(
        "Nanocodex compaction returned a non-contiguous retained history boundary",
      );
    }

    const nodes = [...agent.session.surface.nodes];
    const messages = agent.session.deriveMessages();
    if (nodes.length !== messages.length) {
      throw new Error(
        "Nanocodex compaction cannot map a DSH surface with mismatched messages",
      );
    }
    const admittedSurfaceSeqs =
      mapping === undefined ? undefined : new Set(mapping.admittedSurfaceSeqs);
    const historyProjection = await buildHistoryProjection(
      messages,
      this.ctx,
      signal,
    );
    const surfaceIndexByMessageId = new Map(
      messages.map((message, index) => [String(message.id), index]),
    );
    const projected: SurfaceHistoryItem[] = [];
    for (const projectedItem of historyProjection.items) {
      signal.throwIfAborted();
      const surfaceIndex = surfaceIndexByMessageId.get(
        String(projectedItem.message.id),
      );
      if (surfaceIndex === undefined) continue;
      const surfaceSeq = nodes[surfaceIndex];
      if (
        surfaceSeq === undefined ||
        (admittedSurfaceSeqs !== undefined &&
          !admittedSurfaceSeqs.has(surfaceSeq))
      ) {
        continue;
      }
      projected.push({
        surfaceIndex,
        message: projectedItem.message,
        item: projectedItem.item,
      });
    }

    const contextHistory = outcome.context
      .history as readonly PublicHistoryItem[];
    const retainedContextStart = contextHistory.length - retained.length;
    if (retainedContextStart < 0) {
      throw new Error(
        "Nanocodex compaction context does not contain the retained tail",
      );
    }
    const retainedContext = contextHistory.slice(retainedContextStart);
    if (retainedContext.length !== retained.length) {
      throw new Error(
        "Nanocodex compaction context does not contain the retained tail",
      );
    }
    const directPatchCallIds = validateRetainedApplyPatchPairs(retainedContext);
    const surfaceCustomCallIds = new Set(
      projected.flatMap(({ item }) =>
        item.type === "custom_tool_call" ? [item.call_id] : [],
      ),
    );

    let firstIndex = -1;
    const firstIdentityPosition = retained.findIndex((identity, index) => {
      const contextItem = retainedContext[index];
      return (
        identity.kind === "message" &&
        contextItem?.type === "message" &&
        contextItem.role === "user"
      );
    });
    const firstIdentity =
      firstIdentityPosition < 0 ? undefined : retained[firstIdentityPosition];
    const firstContext =
      firstIdentityPosition < 0
        ? undefined
        : retainedContext[firstIdentityPosition];
    if (
      firstIdentity === undefined ||
      firstContext === undefined ||
      !projectedIdentityMatches(firstIdentity, firstContext)
    ) {
      throw new Error(
        "Nanocodex compaction retained tail does not begin at a real DSH user message",
      );
    }
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      const candidate = projected[index];
      if (
        !isRealUserHistoryItem(candidate) ||
        !projectedIdentityMatches(firstIdentity, candidate.item)
      ) {
        continue;
      }
      if (
        projectedCountForContext(projected, index, firstContext) !== undefined
      ) {
        firstIndex = index;
        break;
      }
    }
    const first = firstIndex < 0 ? undefined : projected[firstIndex];
    if (
      first === undefined ||
      !projectedIdentityMatches(firstIdentity, first.item) ||
      first.surfaceIndex === 0 ||
      !isRealUserHistoryItem(first)
    ) {
      throw new Error(
        "Nanocodex compaction retained tail does not begin at a real DSH user message",
      );
    }

    const codeDispatches = codeDispatchAssociations(agent.session);
    const toolEvidence = dshToolEvidence(agent.session);
    // Validate every DSH-backed identity in authoritative retained order.
    // A retained Code Mode outer pair consumes only its own durable, balanced
    // child pairs. Other engine-owned items have no DSH projection and are
    // ignored, but missing or reordered DSH-backed items are unsafe to map.
    let projectedIndex = firstIndex;
    let pendingCustomCallId: string | null | undefined;
    for (
      let retainedPosition = 0;
      retainedPosition < retained.length;
      retainedPosition += 1
    ) {
      const identity = retained[retainedPosition]!;
      const contextItem = retainedContext[retainedPosition]!;
      const contextCallId =
        "call_id" in contextItem ? contextItem.call_id : undefined;
      const surfaceCustom =
        contextCallId !== undefined &&
        (directPatchCallIds.has(contextCallId) ||
          surfaceCustomCallIds.has(contextCallId));
      const dshBacked =
        identity.kind === "message" ||
        identity.kind === "function_call" ||
        identity.kind === "function_call_output" ||
        surfaceCustom;
      const engineTool =
        !surfaceCustom &&
        (identity.kind === "custom_tool_call" ||
          identity.kind === "custom_tool_call_output");
      if (!dshBacked && !engineTool) {
        if (pendingCustomCallId !== undefined) {
          throw new Error(
            "Nanocodex compaction retained Code Mode tool pair is incomplete",
          );
        }
        continue;
      }
      if (
        !projectedIdentityMatches(identity, retainedContext[retainedPosition]!)
      ) {
        throw new Error(
          "Nanocodex compaction retained history does not match its public context",
        );
      }
      if (engineTool) {
        if (identity.kind === "custom_tool_call") {
          if (pendingCustomCallId !== undefined) {
            throw new Error(
              "Nanocodex compaction retained Code Mode tool pair is incomplete",
            );
          }
          if (typeof identity.call_id === "string") {
            const association = codeDispatches.get(identity.call_id);
            if (association !== undefined) {
              projectedIndex += codeDispatchProjectedCount(
                projected,
                projectedIndex,
                association,
                toolEvidence,
              );
            }
          }
          pendingCustomCallId = identity.call_id;
          continue;
        }
        if (pendingCustomCallId !== identity.call_id) {
          throw new Error(
            "Nanocodex compaction retained Code Mode tool pair is incomplete",
          );
        }
        pendingCustomCallId = undefined;
        continue;
      }
      if (pendingCustomCallId !== undefined) {
        throw new Error(
          "Nanocodex compaction retained Code Mode tool pair is incomplete",
        );
      }
      const candidate = projected[projectedIndex];
      const projectedCount =
        candidate === undefined
          ? undefined
          : projectedCountForContext(
              projected,
              projectedIndex,
              retainedContext[retainedPosition],
            );
      if (
        candidate === undefined ||
        !projectedIdentityMatches(identity, candidate.item)
      ) {
        throw new Error(
          "Nanocodex compaction retained history order does not match the active DSH surface",
        );
      }
      if (candidate.surfaceIndex < first.surfaceIndex) {
        throw new Error(
          "Nanocodex compaction retained tail reaches before its DSH user boundary",
        );
      }
      if (projectedCount === undefined) {
        throw new Error(
          "Nanocodex compaction retained history order does not match the active DSH surface",
        );
      }
      projectedIndex += projectedCount;
    }
    if (pendingCustomCallId !== undefined) {
      throw new Error(
        "Nanocodex compaction retained Code Mode tool pair is incomplete",
      );
    }
    if (projectedIndex !== projected.length) {
      throw new Error(
        "Nanocodex compaction retained tail omits an active DSH history item",
      );
    }

    const start = nodes[0];
    const end = nodes[first.surfaceIndex - 1];
    if (
      start === undefined ||
      end === undefined ||
      !toolPairingBalancedBefore(agent.session, start) ||
      !toolPairingBalancedAfter(agent.session, end)
    ) {
      throw new Error(
        "Nanocodex compaction retained boundary splits a DSH tool exchange",
      );
    }
    return {
      shadowedRange: { start, end },
      shadowedSeqs: nodes.slice(0, first.surfaceIndex),
    };
  }

  private async resolveCompactionInstruction(
    agent: Agent,
    route: ResolvedNanocodexRoute,
    _context: CompactionInstructionContext,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const sessionId = String(agent.session.id) as NonNullable<
      GenerateOptions["sessionId"]
    >;
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: DEFAULT_COMPACTION_INSTRUCTION }],
          source: { kind: "plugin", plugin: "dsh-compaction-basic" },
        }),
      ],
      ...(agent.options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: agent.options.reasoningEffort }),
      sessionId,
      purpose: "compaction",
      signal,
    };
    // Run the existing LLM middleware chain with an empty terminal stream.
    // Consuming the result is required because checkpoint middleware is lazy;
    // it reaches later prompt-selection listeners without dispatching a model.
    const stream = agent.ctx.waterfall(
      agent.ctx.llm,
      "llm/stream",
      options,
      emptyLlmStream,
    );
    for await (const _chunk of stream) {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const instruction = plainText(options.messages).trim();
    if (!instruction) {
      throw new Error("Nanocodex compaction instruction is empty");
    }
    return instruction;
  }

  /** Persist the exact successful engine snapshot at the current DSH surface. */
  async persistCheckpoint(
    agent: Agent,
    provider: string,
    model: NanocodexModel,
    snapshot: SessionSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const session = agent.session;
    const boundary = makeBoundary(session, session.deriveMessages());
    const checkpoint: NanocodexCheckpoint = {
      version: 1,
      provider,
      model,
      boundary,
      snapshot,
    };
    await this.checkpoints.put(session.id, checkpoint);
    const context: RequestContext = {
      provider,
      model,
      contextWindow: MODEL_CONTEXT_WINDOW,
    };
    session.append("request/context", context);
    await this.ctx.sessions.flush(session);
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime !== undefined) runtime.boundary = boundary;
  }

  private async createNodeAgent(
    agent: Agent,
    route: ResolvedNanocodexRoute,
    historySeed: Awaited<ReturnType<typeof buildHistorySeed>>,
    system: string,
    bridge: ToolBridge,
    quickJs: CodeEvaluator,
    resume: SessionSnapshot | undefined,
  ): Promise<NodeAgentHandle> {
    const base = {
      transport: Transport.openAi({
        apiKey: route.apiKey,
        ...(route.apiBaseUrl ? { apiBaseUrl: route.apiBaseUrl } : {}),
        ...(route.websocketUrl ? { websocketUrl: route.websocketUrl } : {}),
        websocketWarmup: true,
      }),
      model: route.model as NanocodexModel,
      ...(route.thinking ? { thinking: route.thinking } : {}),
      ...(agent.options.reasoningEffort === "pro"
        ? { reasoningMode: "pro" as const }
        : {}),
      sessionId: normalizeNanocodexSessionId(String(agent.id)),
      ...(system ? { additionalInstructions: system } : {}),
      resolveCompactionInstruction: (
        context: CompactionInstructionContext,
        signal: AbortSignal,
      ) => this.resolveCompactionInstruction(agent, route, context, signal),
      codeEvaluator: quickJs,
      tools: bridge,
      subagents: false,
      toolMode: "code" as const,
    };
    if (resume !== undefined) {
      try {
        return await NodeAgent.create({ ...base, resume });
      } catch {
        // A DSH checkpoint is an optimization over the authoritative active
        // surface. If a provider/runtime rejects it, rebuild from that surface
        // rather than allowing an opaque stale state to override DSH facts.
      }
    }
    return NodeAgent.create({
      ...base,
      ...(historySeed.history.length > 0 ||
      historySeed.continuitySummary !== undefined
        ? { historySeed }
        : {}),
    });
  }

  private async closeRuntime(runtime: LiveRuntime): Promise<void> {
    await runtime.nodeAgent.session.shutdown().catch(() => undefined);
    runtime.nodeAgent.dispose();
  }

  /** Run custom compaction on the already-live Nanocodex runtime. */
  async compact(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<NanocodexCompactionResult> {
    signal.throwIfAborted();
    const runtime = this.runtimeFor(agent);
    const watcher = runtime.nodeAgent.events.watch();
    let eventOutcome: CompactionOutcome | undefined;
    let installed = false;
    let succeeded = false;
    const removeListener = watcher.onEvent((event) => {
      const replaced = parseCompactionReplacedEvent(event);
      if (replaced === undefined || replaced.trigger !== "manual") return;
      installed = true;
      if (this.consumeCompactionOutcome(runtime, replaced)) {
        eventOutcome = replaced;
      }
    });
    const removeTransportFallback = observeTransportFallback(
      this.ctx,
      String(agent.id),
      runtime.nodeAgent,
    );
    let shutdownRequested = false;
    const abort = () => {
      shutdownRequested = true;
      void runtime.nodeAgent.session.shutdown().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const returned = await runtime.nodeAgent.session.compact();
      signal.throwIfAborted();
      if (returned === null) {
        throw new Error(
          "Nanocodex manual compaction did not produce one matching replacement event",
        );
      }
      // The accepted Nanocodex contract requires this to happen in the same
      // idle maintenance operation, immediately after compact resolves. Do
      // not derive a snapshot from outcome.context or wait for another turn.
      const snapshot = await runtime.nodeAgent.session.snapshot();
      signal.throwIfAborted();
      if (
        eventOutcome === undefined ||
        returned.revision !== eventOutcome.revision
      ) {
        throw new Error(
          "Nanocodex manual compaction did not produce one matching replacement event",
        );
      }
      const summary = returned.summary?.trim();
      if (!summary) {
        throw new Error("Nanocodex compaction returned no summary text");
      }
      const selection = await this.mapCompactionOutcome(
        agent,
        returned,
        signal,
      );
      succeeded = true;
      return {
        summary,
        outcome: returned,
        selection,
        snapshot,
        provider: runtime.provider,
        model: runtime.model,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      removeListener();
      watcher.off();
      removeTransportFallback();
      if (shutdownRequested || (installed && !succeeded)) {
        await this.invalidate(agent).catch(() => undefined);
      }
    }
  }

  private appendRequestFacts(
    agent: Agent,
    provider: string,
    model: NanocodexModel,
    reasoningEffort: Agent["options"]["reasoningEffort"],
    system: string,
    bridge: readonly {
      readonly name: string;
      readonly description: string;
      readonly parameters?: Record<string, unknown> | undefined;
    }[],
  ): void {
    const tools: ToolSchema[] = bridge.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }));
    const header = canonicalHeader({
      config: {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    });
    const session = agent.session;
    const baseline = session.requestHeader();
    const hasLiveHeader = session
      .snapshotEvents(session.firstLiveSeq)
      .some((event) => event.type === "request/header");
    const previousGeneration = this.requestSurfaceGeneration.get(session);
    const startsSeries =
      previousGeneration !== undefined &&
      previousGeneration !== session.surface.replaceGeneration;
    if (!hasLiveHeader) {
      session.append("request/header", {
        header,
        reason: baseline === undefined ? "initial" : "resume",
      });
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append("request/header", {
        header,
        reason: "change",
        ...(startsSeries ? { startsSeries: true } : {}),
      });
    } else if (startsSeries) {
      session.append("request/header", { header, reason: "series" });
    }
    this.requestSurfaceGeneration.set(
      session,
      session.surface.replaceGeneration,
    );
    const requestContext = {
      provider,
      model,
      contextWindow: MODEL_CONTEXT_WINDOW,
    };
    const previousContext = session.requestContext();
    if (
      previousContext?.provider !== requestContext.provider ||
      previousContext.model !== requestContext.model ||
      previousContext.contextWindow !== requestContext.contextWindow
    ) {
      session.append("request/context", requestContext);
    }
  }

  private appendToolResult(
    agent: Agent,
    turn: number,
    step: number,
    id: string,
    callSeq: SessionSeq,
    result: ToolExecutionResult,
  ): void {
    const message = createToolResultMessage({
      callId: ToolCallId(id),
      content: result.content,
      isError: result.isError,
    });
    agent.session.append(
      "tool/result",
      {
        turn,
        step,
        message,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
      },
      { surfaceOp: "append", sourceEventSeqs: [callSeq] },
    );
  }
}
