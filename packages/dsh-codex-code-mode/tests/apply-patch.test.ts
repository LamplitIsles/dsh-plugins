import type { Context } from "@deepseek-ai/cordis";
import type {
  FileSystem,
  FsInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyChunks,
  applyPatchToFileSystem,
  createApplyPatchTool,
  PatchError,
  parsePatch,
  type ApplyPatchOutcome,
} from "../src/index.js";

const WORKSPACE = "/workspace";

type FileRecord = {
  text: string;
  version: string;
};

type WriteCall = {
  path: string;
  content: string;
  expected: FsWriteIntent | undefined;
};

function filesystemError(
  code: string,
  message: string,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

class FakeFileSystem {
  readonly files = new Map<string, FileRecord>();
  readonly writes: WriteCall[] = [];
  readonly resolutions: string[] = [];
  failPath: string | undefined;
  cancelAfterPath: string | undefined;
  private nextVersion = 1;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(initial)) this.set(path, text);
  }

  private absolute(path: string, cwd = WORKSPACE): string {
    return posix.normalize(path.startsWith("/") ? path : posix.join(cwd, path));
  }

  private set(path: string, text: string): void {
    this.files.set(this.absolute(path), {
      text,
      version: `v${this.nextVersion++}`,
    });
  }

  text(path: string): string | undefined {
    return this.files.get(this.absolute(path))?.text;
  }

  resolve(
    path: string,
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    options?.signal?.throwIfAborted();
    const resolved = this.absolute(path, options?.cwd ?? WORKSPACE);
    this.resolutions.push(resolved);
    return Promise.resolve({
      targetKey: resolved as never,
      displayPath: resolved,
    });
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const root = parent.displayPath.replace(/\/+$/u, "");
    return (
      child.displayPath === root || child.displayPath.startsWith(`${root}/`)
    );
  }

  stat(target: FsTarget): Promise<FsInfo | undefined> {
    if (target.displayPath === WORKSPACE)
      return Promise.resolve({
        type: "directory",
        version: "workspace" as never,
      });
    const record = this.files.get(target.displayPath);
    return Promise.resolve(
      record === undefined
        ? undefined
        : {
            type: "file",
            size: new TextEncoder().encode(record.text).byteLength,
            version: record.version as never,
          },
    );
  }

  readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const record = this.files.get(target.displayPath);
    if (record === undefined)
      return Promise.reject(filesystemError("FS_NOT_FOUND", "file not found"));
    return Promise.resolve(record.text);
  }

  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    signal?.throwIfAborted();
    this.writes.push({ path: target.displayPath, content, expected });
    if (this.failPath === target.displayPath)
      return Promise.reject(
        filesystemError("FS_WRITE_FAILED", "injected write failure"),
      );
    const current = this.files.get(target.displayPath);
    if (expected?.kind === "createIfAbsent" && current !== undefined)
      return Promise.reject(
        filesystemError(
          "FS_NOT_OBSERVED",
          "cannot overwrite an observed target",
        ),
      );
    if (
      expected?.kind === "replaceIfVersion" &&
      (current === undefined || current.version !== expected.version)
    )
      return Promise.reject(
        filesystemError("FS_STALE_VERSION", "file changed after preflight"),
      );
    const version = `v${this.nextVersion++}`;
    this.files.set(target.displayPath, { text: content, version });
    if (this.cancelAfterPath === target.displayPath) {
      // The first write is committed, then the caller observes cancellation at
      // the next publication boundary.
      signal?.throwIfAborted();
    }
    return Promise.resolve({
      operation: current === undefined ? "create" : "update",
      version: version as never,
      before: current?.text ?? null,
      after: content,
    });
  }
}

class FakeContext {
  readonly observations: unknown[][] = [];

  emit(...args: unknown[]): void {
    this.observations.push(args);
  }

  waterfall(
    _carrier: object,
    _event: string,
    _target: FsTarget,
    _exec: object,
    fallback: () => Promise<FsWriteIntent>,
  ): Promise<FsWriteIntent> {
    return fallback();
  }
}

function services(initial: Record<string, string> = {}) {
  const fs = new FakeFileSystem(initial);
  const ctx = new FakeContext();
  return {
    fs,
    ctx,
    services: {
      fs: fs as unknown as FileSystem,
      ctx: ctx as unknown as Context,
    },
  };
}

function execution(signal = new AbortController().signal): object {
  return {
    agent: { session: { header: { cwd: WORKSPACE } } },
    signal,
  };
}

async function runPatch(
  patch: string,
  setup: Record<string, string> = {},
  signal = new AbortController().signal,
): Promise<{
  outcome: ApplyPatchOutcome;
  fs: FakeFileSystem;
  ctx: FakeContext;
}> {
  const fixture = services(setup);
  const outcome = await applyPatchToFileSystem(
    patch,
    fixture.services,
    execution(signal) as never,
  );
  return { outcome, fs: fixture.fs, ctx: fixture.ctx };
}

describe("Codex patch parsing and matching", () => {
  it("parses Add File, contextual Update File, line deletion, and EOF anchoring", () => {
    const parsed = parsePatch(`*** Begin Patch
*** Add File: notes/new.txt
+first
+second
*** Update File: src/example.ts
@@ function main
-  removeMe()
+  keepMe()
   return true
*** End of File
*** End Patch`);

    expect(parsed.operations).toMatchObject([
      { kind: "add", path: "notes/new.txt", content: "first\nsecond\n" },
      {
        kind: "update",
        path: "src/example.ts",
        chunks: [
          {
            changeContext: "function main",
            oldLines: ["  removeMe()", "  return true"],
            newLines: ["  keepMe()", "  return true"],
            isEndOfFile: true,
          },
        ],
      },
    ]);
    const update = parsed.operations[1];
    if (update?.kind !== "update") throw new Error("expected update operation");
    expect(
      applyChunks(
        "header\nfunction main\n  removeMe()\n  return true\n",
        "src/example.ts",
        update.chunks,
      ),
    ).toBe("header\nfunction main\n  keepMe()\n  return true\n");
  });

  it.each([
    "*** Delete File: old.txt",
    "*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new",
  ])(
    "rejects unsupported delete or move operations before execution (%s)",
    (operation) => {
      expect(() =>
        parsePatch(`*** Begin Patch\n${operation}\n*** End Patch`),
      ).toThrow(PatchError);
      let error: unknown;
      try {
        parsePatch(`*** Begin Patch\n${operation}\n*** End Patch`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "PATCH_UNSUPPORTED" });
    },
  );
});

describe("Codex patch filesystem execution", () => {
  it("preflights all files, then applies Add and Update through guarded filesystem writes", async () => {
    const patch = `*** Begin Patch
*** Add File: added.txt
+created
*** Update File: existing.txt
@@
-before
+after
*** End Patch`;
    const result = await runPatch(patch, { "existing.txt": "before\n" });

    expect(result.outcome.status).toBe("applied");
    expect(result.fs.text("added.txt")).toBe("created\n");
    expect(result.fs.text("existing.txt")).toBe("after\n");
    expect(result.fs.writes.map(({ path }) => path)).toEqual([
      "/workspace/added.txt",
      "/workspace/existing.txt",
    ]);
    expect(result.fs.writes[0]?.expected).toEqual({ kind: "createIfAbsent" });
    expect(result.fs.writes[1]?.expected?.kind).toBe("replaceIfVersion");
    expect(result.outcome.operations.map(({ status }) => status)).toEqual([
      "committed",
      "committed",
    ]);
    expect(result.outcome.diffs.map(({ path }) => path)).toEqual([
      "added.txt",
      "existing.txt",
    ]);
    expect(result.ctx.observations.length).toBe(2);
  });

  it("checks every update observation before publishing an earlier add", async () => {
    const fixture = services({ "existing.txt": "before\n" });
    let updateObserved = false;
    const originalWaterfall = fixture.ctx.waterfall.bind(fixture.ctx);
    fixture.ctx.waterfall = ((carrier, event, target, exec, fallback) => {
      if (event === "fs/edit-intent" && !updateObserved) {
        updateObserved = true;
        return Promise.reject(
          filesystemError("FS_NOT_OBSERVED", "read the file first"),
        );
      }
      return originalWaterfall(carrier, event, target, exec, fallback);
    }) as typeof fixture.ctx.waterfall;

    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Add File: added.txt\n++created\n*** Update File: existing.txt\n@@\n-before\n+after\n*** End Patch`,
        fixture.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "FS_NOT_OBSERVED" });
    expect(fixture.fs.writes).toHaveLength(0);
    expect(fixture.fs.text("added.txt")).toBeUndefined();
  });

  it("rejects a stale second target during preflight without publishing the first", async () => {
    const fixture = services({ "second.txt": "before\n" });
    let editCalls = 0;
    const originalWaterfall = fixture.ctx.waterfall.bind(fixture.ctx);
    fixture.ctx.waterfall = ((carrier, event, target, exec, fallback) => {
      if (event === "fs/edit-intent") {
        editCalls += 1;
        if (editCalls === 1)
          return Promise.resolve({ version: "stale-version" as never });
      }
      return originalWaterfall(carrier, event, target, exec, fallback);
    }) as typeof fixture.ctx.waterfall;

    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Add File: first.txt\n++created\n*** Update File: second.txt\n@@\n-before\n+after\n*** End Patch`,
        fixture.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "FS_STALE_VERSION" });
    expect(fixture.fs.writes).toHaveLength(0);
    expect(fixture.fs.text("first.txt")).toBeUndefined();
    expect(fixture.fs.text("second.txt")).toBe("before\n");
  });

  it("enforces caller-supplied processing limits before filesystem work", async () => {
    const fixture = services();
    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Add File: added.txt\n++created\n*** End Patch`,
        fixture.services,
        execution() as never,
        { maxPatchChars: 10, maxPatchFiles: 1, maxPatchFileBytes: 100 },
      ),
    ).rejects.toMatchObject({ code: "PATCH_TOO_LARGE" });
    expect(fixture.fs.resolutions).toHaveLength(0);
  });

  it("does not publish when a later operation fails preflight, targets duplicate files, or escapes the workspace", async () => {
    const invalidLater = `*** Begin Patch
*** Add File: first.txt
+must not publish
*** Update File: missing.txt
@@
-absent
+still absent
*** End Patch`;
    const first = services();
    await expect(
      applyPatchToFileSystem(
        invalidLater,
        first.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "PATCH_INVALID" });
    expect(first.fs.writes).toHaveLength(0);
    expect(first.fs.text("first.txt")).toBeUndefined();

    const duplicate = services();
    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Add File: a.txt\n++one\n*** Add File: ./a.txt\n++two\n*** End Patch`,
        duplicate.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "PATCH_INVALID" });
    expect(duplicate.fs.writes).toHaveLength(0);

    const denied = services();
    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Add File: ../outside.txt\n++secret\n*** End Patch`,
        denied.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "PATCH_PATH_INVALID" });
    expect(denied.fs.writes).toHaveLength(0);
  });

  it("keeps stale guarded writes and malformed input mutation-free", async () => {
    const stale = services({ "existing.txt": "before\n" });
    stale.fs.failPath = "/workspace/existing.txt";
    await expect(
      applyPatchToFileSystem(
        `*** Begin Patch\n*** Update File: existing.txt\n@@\n-before\n+after\n*** End Patch`,
        stale.services,
        execution() as never,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      operations: [{ path: "existing.txt", status: "failed" }],
      error: { code: "FS_WRITE_FAILED" },
    });
    expect(stale.fs.text("existing.txt")).toBe("before\n");

    const malformed = services();
    await expect(
      applyPatchToFileSystem(
        "not a patch",
        malformed.services,
        execution() as never,
      ),
    ).rejects.toMatchObject({ code: "PATCH_INVALID" });
    expect(malformed.fs.resolutions).toHaveLength(0);
    expect(malformed.fs.writes).toHaveLength(0);
  });

  it("reports ordered partial publication and cancellation without rollback or retry", async () => {
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-a0
+a1
*** Update File: b.txt
@@
-b0
+b1
*** Update File: c.txt
@@
-c0
+c1
*** End Patch`;
    const failed = services({
      "a.txt": "a0\n",
      "b.txt": "b0\n",
      "c.txt": "c0\n",
    });
    failed.fs.failPath = "/workspace/b.txt";
    const partial = await applyPatchToFileSystem(
      patch,
      failed.services,
      execution() as never,
    );
    expect(partial.status).toBe("partial");
    expect(
      partial.operations.map(({ path, status }) => [path, status]),
    ).toEqual([
      ["a.txt", "committed"],
      ["b.txt", "failed"],
      ["c.txt", "unattempted"],
    ]);
    expect(failed.fs.text("a.txt")).toBe("a1\n");
    expect(failed.fs.text("b.txt")).toBe("b0\n");
    expect(failed.fs.text("c.txt")).toBe("c0\n");
    expect(failed.fs.writes.map(({ path }) => path)).toEqual([
      "/workspace/a.txt",
      "/workspace/b.txt",
    ]);

    const controller = new AbortController();
    const cancelled = services({
      "a.txt": "a0\n",
      "b.txt": "b0\n",
      "c.txt": "c0\n",
    });
    cancelled.fs.cancelAfterPath = "/workspace/a.txt";
    const originalWrite = cancelled.fs.writeText.bind(cancelled.fs);
    cancelled.fs.writeText = ((target, content, expected, signal) => {
      const result = originalWrite(target, content, expected, signal);
      controller.abort("test cancellation");
      return result;
    }) as typeof cancelled.fs.writeText;
    const cancellation = await applyPatchToFileSystem(
      patch,
      cancelled.services,
      execution(controller.signal) as never,
    );
    expect(cancellation.status).toBe("cancelled");
    expect(
      cancellation.operations.map(({ path, status }) => [path, status]),
    ).toEqual([
      ["a.txt", "committed"],
      ["b.txt", "unattempted"],
      ["c.txt", "unattempted"],
    ]);
    expect(cancelled.fs.text("a.txt")).toBe("a1\n");
    expect(cancelled.fs.writes.map(({ path }) => path)).toEqual([
      "/workspace/a.txt",
    ]);
  });

  it("keeps committed progress in presentation metadata and the final content hook", async () => {
    const fixture = services({ "a.txt": "a0\n", "b.txt": "b0\n" });
    fixture.fs.failPath = "/workspace/b.txt";
    const progress = new WeakMap<
      object,
      { readonly outcome: ApplyPatchOutcome }
    >();
    const tool = createApplyPatchTool(fixture.services, progress);
    const exec = {
      ...execution(),
      arguments: { patch: "durable patch" },
    };
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-a0
+a1
*** Update File: b.txt
@@
-b0
+b1
*** End Patch`;
    const outcome = (await tool.execute(
      { patch },
      exec as never,
    )) as ApplyPatchOutcome;
    expect(outcome.status).toBe("partial");
    const meta = tool.output.presentationMeta?.(
      { patch },
      JSON.parse(JSON.stringify(outcome)),
    );
    expect(meta).toMatchObject({ diffs: [{ path: "a.txt", newText: "a1\n" }] });
    expect(
      tool.presentResult?.(
        { patch },
        {
          content: [],
          isError: false,
          ...(meta === undefined ? {} : { meta }),
        },
      ),
    ).toMatchObject({ card: "diff", diffs: [{ path: "a.txt" }] });
    const finalized = tool.finalizeContent?.(exec as never, {
      content: [{ type: "text", text: "generic registry error" }],
      isError: true,
      error: { message: "generic registry error" },
    });
    expect(finalized).toBeDefined();
    if (finalized === undefined) throw new Error("expected finalized content");
    expect(finalized[0]).toMatchObject({ type: "text" });
    expect((finalized[0] as { text?: string }).text).toContain(
      "Committed: a.txt.",
    );
    expect((finalized[0] as { text?: string }).text).toContain(
      "Failed: b.txt.",
    );
  });
});
