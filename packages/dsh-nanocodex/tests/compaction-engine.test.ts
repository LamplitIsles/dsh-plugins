import { Context } from "@deepseek-ai/cordis";
import { type ManualCompactAgentContext } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { NanocodexCompactionEngine } from "../src/compaction-engine.js";
import {
  NanocodexEngine,
  type NanocodexCompactionResult,
} from "../src/engine.js";
import type { SessionSnapshot } from "nanocodex/node";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class StubEngine {
  readonly started = deferred<void>();

  constructor(private readonly failure: Error | undefined) {}

  async compact(
    _agent: unknown,
    signal: AbortSignal,
  ): Promise<NanocodexCompactionResult> {
    if (this.failure !== undefined) throw this.failure;
    this.started.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
    return undefined as never;
  }
}

class PersistingEngine {
  readonly calls: string[] = [];
  persistedNodes: readonly SessionSeq[] | undefined;

  constructor(private readonly persistFailure = false) {}

  async compact(
    agent: {
      readonly session: {
        readonly surface: { readonly nodes: readonly SessionSeq[] };
      };
    },
    signal: AbortSignal,
  ): Promise<NanocodexCompactionResult> {
    signal.throwIfAborted();
    this.calls.push("compact");
    const nodes = [...agent.session.surface.nodes];
    const shadowedSeqs = nodes.slice(0, -1);
    return {
      summary: "persisted summary",
      outcome: undefined as never,
      selection: {
        shadowedRange: {
          start: shadowedSeqs[0]!,
          end: shadowedSeqs.at(-1)!,
        },
        shadowedSeqs,
      },
      snapshot: {} as SessionSnapshot,
      provider: "openai",
      model: "gpt-5.6-sol",
    };
  }

  markSurfaceBoundary(): void {
    this.calls.push("mark");
  }

  async persistCheckpoint(agent: {
    readonly session: {
      readonly surface: { readonly nodes: readonly SessionSeq[] };
    };
  }): Promise<void> {
    this.calls.push("persist");
    this.persistedNodes = [...agent.session.surface.nodes];
    if (this.persistFailure) throw new Error("checkpoint persistence failed");
  }

  async invalidate(): Promise<void> {
    this.calls.push("invalidate");
  }
}

async function fixture(id: string, engine: unknown) {
  const root = new Context();
  const sessions = root.plugin(SessionStore);
  await sessions;
  const preparation = SessionPreparation.create(
    root.sessions.prepare(SessionId(id)),
  );
  const session = preparation.session;
  const detachSession = root.sessions.enter(session);
  for (const text of ["one", "two", "three", "four", "five"]) {
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
  }
  const agent = {
    session,
    options: { provider: "openai", model: "gpt-5.6-sol" },
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) =>
      task(new AbortController().signal),
  } as ManualCompactAgentContext;
  const compaction = new NanocodexCompactionEngine(
    root,
    engine as unknown as NanocodexEngine,
  );
  return {
    sessionsHandle: sessions,
    preparation,
    detachSession,
    session,
    agent,
    compaction,
  };
}

async function close(fixtureValue: Awaited<ReturnType<typeof fixture>>) {
  fixtureValue.detachSession();
  fixtureValue.preparation[Symbol.dispose]();
  await fixtureValue.sessionsHandle.dispose();
}

describe("Nanocodex compaction failure boundaries", () => {
  it("leaves no successful summary when the model fails", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-8000-000000000101",
      new StubEngine(new Error("summary failed")),
    );
    const before = [...value.session.surface.nodes];
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "summary",
      });
      expect(value.session.surface.nodes).toEqual(before);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "compaction/summary"),
      ).toHaveLength(0);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "compaction/end"),
      ).toHaveLength(1);
    } finally {
      await close(value);
    }
  });

  it("closes a canceled attempt without publishing a summary", async () => {
    const engine = new StubEngine(undefined);
    const value = await fixture("018f1f9a-7b3c-7a10-8000-000000000102", engine);
    const before = [...value.session.surface.nodes];
    const controller = new AbortController();
    const reason = new Error("user stopped compaction");
    try {
      const pending = value.compaction.compactNow(
        value.agent,
        controller.signal,
      );
      await engine.started.promise;
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(value.session.surface.nodes).toEqual(before);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "compaction/summary"),
      ).toHaveLength(0);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "compaction/end"),
      ).toHaveLength(1);
    } finally {
      await close(value);
    }
  });

  it("rejects an arbitrary region before touching the live engine", async () => {
    const engine = new StubEngine(new Error("must not run"));
    const value = await fixture("018f1f9a-7b3c-7a10-8000-000000000103", engine);
    const nodes = [...value.session.surface.nodes];
    const before = [...nodes];
    try {
      await expect(
        value.compaction.compactRegion(
          nodes[1]!,
          nodes[1]!,
          value.agent,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "changed" });
      expect(value.session.surface.nodes).toEqual(before);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "compaction/start"),
      ).toHaveLength(0);
    } finally {
      await close(value);
    }
  });

  it("persists the engine snapshot after replacing the exact DSH surface", async () => {
    const engine = new PersistingEngine();
    const value = await fixture("018f1f9a-7b3c-7a10-8000-000000000104", engine);
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).resolves.toMatchObject({
        summary: [{ type: "text", text: "persisted summary" }],
      });
      expect(engine.calls).toEqual(["compact", "mark", "persist"]);
      expect(engine.persistedNodes).toEqual(value.session.surface.nodes);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "request/context"),
      ).toHaveLength(0);
    } finally {
      await close(value);
    }
  });

  it("invalidates the live runtime when checkpoint persistence fails", async () => {
    const engine = new PersistingEngine(true);
    const value = await fixture("018f1f9a-7b3c-7a10-8000-000000000105", engine);
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).rejects.toMatchObject({ code: "summary" });
      expect(engine.calls).toEqual([
        "compact",
        "mark",
        "persist",
        "invalidate",
      ]);
      expect(engine.persistedNodes).toEqual(value.session.surface.nodes);
    } finally {
      await close(value);
    }
  });
});
