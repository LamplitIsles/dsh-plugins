import { Context } from "@deepseek-ai/cordis";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type Message,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
  type Session,
  type SessionSeq,
} from "@deepseek-ai/dsh-session";
import type { CompactionOutcome, SessionSnapshot } from "nanocodex/node";
import { describe, expect, it } from "vitest";
import { NanocodexCompactionEngine } from "../src/compaction-engine.js";
import type {
  NanocodexAutomaticCompaction,
  NanocodexCompactionResult,
  NanocodexCompactionSelection,
} from "../src/engine.js";

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

function accounting() {
  return { contextWindowTokens: 272_000, activeContextTokens: 12_345 };
}

function selectionFor(
  session: Session,
  shadowedNodes: readonly SessionSeq[] = [...session.surface.nodes].slice(
    0,
    -1,
  ),
): NanocodexCompactionSelection {
  if (shadowedNodes.length === 0) throw new Error("fixture needs a reduction");
  return {
    shadowedRange: {
      start: shadowedNodes[0]!,
      end: shadowedNodes.at(-1)!,
    },
    shadowedSeqs: [...shadowedNodes],
    segments: [
      {
        start: shadowedNodes[0]!,
        end: shadowedNodes.at(-1)!,
        shadowedSeqs: [...shadowedNodes],
        kind: "remove",
      },
    ],
    context: accounting(),
  };
}

function mixedReplacementSelection(
  session: Session,
): NanocodexCompactionSelection {
  const [user, assistant, anchor] = [...session.surface.nodes].slice(0, 3);
  if (user === undefined || assistant === undefined || anchor === undefined) {
    throw new Error("fixture needs a mixed replacement span");
  }
  return {
    shadowedRange: { start: user, end: anchor },
    shadowedSeqs: [user, assistant, anchor],
    segments: [
      {
        start: user,
        end: user,
        shadowedSeqs: [user],
        kind: "replace",
        message: createUserMessage({
          content: [{ type: "text", text: "visible user replacement" }],
          source: { kind: "user" },
        }),
      },
      {
        start: assistant,
        end: assistant,
        shadowedSeqs: [assistant],
        kind: "replace",
        message: createAssistantMessage({
          content: [{ type: "text", text: "visible assistant replacement" }],
          source: { provider: "openai", model: "gpt-5.6-sol" },
        }),
      },
      {
        start: anchor,
        end: anchor,
        shadowedSeqs: [anchor],
        kind: "remove",
      },
    ],
    context: accounting(),
  };
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
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    signal.throwIfAborted();
    return undefined as never;
  }
}

class PersistingEngine {
  readonly calls: string[] = [];
  persistedNodes: readonly SessionSeq[] | undefined;

  constructor(
    private readonly persistFailure = false,
    private readonly selectionFactory: (
      session: Session,
    ) => NanocodexCompactionSelection = selectionFor,
  ) {}

  async compact(
    agent: { readonly session: Session },
    signal: AbortSignal,
  ): Promise<NanocodexCompactionResult> {
    signal.throwIfAborted();
    this.calls.push("compact");
    return {
      summary: "persisted summary",
      outcome: undefined as never,
      selection: this.selectionFactory(agent.session),
      snapshot: {} as SessionSnapshot,
      provider: "openai",
      model: "gpt-5.6-sol",
      context: accounting(),
    };
  }

  async mapCompactionOutcome(agent: {
    readonly session: Session;
  }): Promise<NanocodexCompactionSelection> {
    return this.selectionFactory(agent.session);
  }

  markSurfaceBoundary(): void {
    this.calls.push("mark");
  }

  async persistCheckpoint(agent: { readonly session: Session }): Promise<void> {
    this.calls.push("persist");
    this.persistedNodes = [...agent.session.surface.nodes];
    if (this.persistFailure) throw new Error("checkpoint persistence failed");
  }

  async invalidate(): Promise<void> {
    this.calls.push("invalidate");
  }
}

async function fixture(
  id: string,
  engine: unknown,
  beforeTail?: (session: Session) => void,
) {
  const root = new Context();
  const sessions = root.plugin(SessionStore);
  await sessions;
  const preparation = SessionPreparation.create(
    root.sessions.prepare(SessionId(id)),
  );
  const session = preparation.session;
  const detachSession = root.sessions.enter(session);
  root.provide("tokenMeter", {
    estimateMessage: (message: Message): number =>
      10 +
      message.content.reduce(
        (total, block) =>
          total + (block.type === "text" ? block.text.length : 50),
        0,
      ),
  } as unknown as Context["tokenMeter"]);
  beforeTail?.(session);
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
  } as unknown as Parameters<NanocodexCompactionEngine["compactNow"]>[0];
  const compaction = new NanocodexCompactionEngine(root, engine as never);
  return {
    sessionsHandle: sessions,
    preparation,
    detachSession,
    session,
    agent,
    compaction,
  };
}

async function close(
  value: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  value.detachSession();
  value.preparation[Symbol.dispose]();
  await value.sessionsHandle.dispose();
}

describe("Nanocodex compaction failure boundaries", () => {
  it("leaves no successful summary when the model fails", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000601",
      new StubEngine(new Error("summary failed")),
    );
    const before = [...value.session.surface.nodes];
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).rejects.toMatchObject({ code: "summary" });
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
    const value = await fixture("018f1f9a-7b3c-7a10-0000-000000000602", engine);
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
    const value = await fixture("018f1f9a-7b3c-7a10-0000-000000000603", engine);
    const nodes = [...value.session.surface.nodes];
    try {
      await expect(
        value.compaction.compactRegion(
          nodes[1]!,
          nodes[1]!,
          value.agent,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "changed" });
      expect(value.session.surface.nodes).toEqual(nodes);
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
    const value = await fixture("018f1f9a-7b3c-7a10-0000-000000000604", engine);
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).resolves.toMatchObject({
        summary: [{ type: "text", text: "persisted summary" }],
        shadowedTokenCount: 55,
      });
      expect(engine.calls).toEqual(["compact", "mark", "persist"]);
      expect(engine.persistedNodes).toEqual(value.session.surface.nodes);
      const summary = value.session
        .snapshotEvents()
        .find((event) => event.type === "compaction/summary");
      expect(summary?.data.shadowedTokenCount).toBe(55);
      expect(
        value.session
          .snapshotEvents()
          .filter((event) => event.type === "request/context"),
      ).toHaveLength(0);
    } finally {
      await close(value);
    }
  });

  it("installs mixed-message replacements without image or reasoning blocks", async () => {
    const engine = new PersistingEngine(false, mixedReplacementSelection);
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000608",
      engine,
      (session) => {
        const user = session.append(
          "user/message",
          createUserMessage({
            content: [
              { type: "text", text: "mixed user" },
              {
                type: "image",
                attachment: {
                  attachmentId: AttachmentId("sha256:engine-fixture-image"),
                  mediaType: "image/png",
                  bytes: 3,
                  width: 1,
                  height: 1,
                },
              },
            ],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
        session.append(
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [
                { type: "reasoning", text: "engine private reasoning" },
                { type: "text", text: "mixed assistant" },
              ],
              source: { provider: "openai", model: "gpt-5.6-sol" },
            }),
          },
          { surfaceOp: "append", sourceEventSeqs: [user.seq] },
        );
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: "summary anchor" }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      },
    );
    try {
      await expect(
        value.compaction.compactNow(value.agent, new AbortController().signal),
      ).resolves.toMatchObject({
        summary: [{ type: "text", text: "persisted summary" }],
      });
      const messages = value.session.deriveMessages();
      const blocks = messages.flatMap((message) => message.content);

      expect(
        messages.some((message) =>
          message.content.some(
            (block) =>
              block.type === "text" &&
              block.text === "visible user replacement",
          ),
        ),
      ).toBe(true);
      expect(
        messages.some((message) =>
          message.content.some(
            (block) =>
              block.type === "text" &&
              block.text === "visible assistant replacement",
          ),
        ),
      ).toBe(true);
      expect(blocks.some((block) => block.type === "image")).toBe(false);
      expect(blocks.some((block) => block.type === "reasoning")).toBe(false);
      expect(engine.persistedNodes).toEqual(value.session.surface.nodes);
    } finally {
      await close(value);
    }
  });

  it("invalidates the live runtime when checkpoint persistence fails", async () => {
    const engine = new PersistingEngine(true);
    const value = await fixture("018f1f9a-7b3c-7a10-0000-000000000605", engine);
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

it("prices a tool-heavy selected range through the Host token meter", async () => {
  const callId = ToolCallId("fixture-tool");
  const value = await fixture(
    "018f1f9a-7b3c-7a10-0000-000000000606",
    new PersistingEngine(),
    (session) => {
      const user = session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "tool prompt" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      const call = session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              {
                type: "tool-call",
                id: callId,
                name: "exec",
                arguments: JSON.stringify({ code: "return 1" }),
              },
            ],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append", sourceEventSeqs: [user.seq] },
      );
      session.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: "text", text: "one" }],
            isError: false,
          }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
      );
    },
  );
  try {
    const messages = value.session.deriveMessages();
    const expected = messages
      .slice(0, -1)
      .reduce(
        (total, message) =>
          total +
          10 +
          message.content.reduce(
            (inner, block) =>
              inner + (block.type === "text" ? block.text.length : 50),
            0,
          ),
        0,
      );
    await expect(
      value.compaction.commitAutomaticSummary(
        value.agent,
        {
          outcome: {
            revision: "automatic-fixture",
            trigger: "automatic",
            summary: "automatic summary",
            installed_history: [],
            context: {
              workspace: ".",
              history: [],
              context_window_tokens: 272_000,
              active_context_tokens: 10,
            },
          } as CompactionOutcome,
          phase: "pre_turn",
          afterModelCallIndex: 0,
        } satisfies NanocodexAutomaticCompaction,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ shadowedTokenCount: expected });
    expect(
      value.session
        .snapshotEvents()
        .find((event) => event.type === "compaction/summary")?.data
        .shadowedTokenCount,
    ).toBe(expected);
  } finally {
    await close(value);
  }
});

it("estimates selected surface order after a replacement creates nonmonotonic seqs", async () => {
  const value = await fixture(
    "018f1f9a-7b3c-7a10-0000-000000000607",
    new PersistingEngine(),
  );
  try {
    const nodes = [...value.session.surface.nodes];
    value.session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "preexisting" }],
        source: { kind: "plugin", plugin: "compact" },
      }),
      {
        surfaceOp: { op: "replace", start: nodes[0]!, end: nodes[1]! },
        sourceEventSeqs: nodes.slice(0, 2),
      },
    );
    expect(value.session.surface.nodes[0]).toBeGreaterThan(
      value.session.surface.nodes[1]!,
    );
    await expect(
      value.compaction.compactNow(value.agent, new AbortController().signal),
    ).resolves.toMatchObject({ shadowedTokenCount: 50 });
  } finally {
    await close(value);
  }
});
