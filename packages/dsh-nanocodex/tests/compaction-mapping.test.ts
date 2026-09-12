import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import { Context } from "@deepseek-ai/cordis";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContentBlock,
  type Message,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
  type Session,
} from "@deepseek-ai/dsh-session";
import type {
  CompactionContext,
  CompactionHistoryItem,
  CompactionItemIdentity,
  HistoryItem,
} from "nanocodex/node";
import { describe, expect, it } from "vitest";
import {
  buildHistoryProjection,
  isNanocodexSurfacePlaceholder,
} from "../src/history.js";
import {
  buildNanocodexCompactionPlan,
  COMPACTION_VISIBLE_ROUND_LIMIT,
  COMPACTION_VISIBLE_TOKEN_BUDGET,
} from "../src/compaction-policy.js";

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId("sha256:compaction-fixture-image"),
  mediaType: "image/png",
  bytes: 3,
  width: 1,
  height: 1,
};

function attachments(): AttachmentStore {
  return {
    readImage: async (ref: ImageAttachmentRef) => ({
      ref,
      data: new Uint8Array([1, 2, 3]),
    }),
  } as unknown as AttachmentStore;
}

function textLength(message: Message): number {
  return message.content.reduce(
    (total, block) => total + (block.type === "text" ? block.text.length : 0),
    0,
  );
}

function identity(index: number, item: HistoryItem): CompactionItemIdentity {
  const record = item as unknown as Record<string, unknown>;
  return {
    index,
    kind: typeof record.type === "string" ? record.type : "unknown",
    id: typeof record.id === "string" ? record.id : null,
    call_id: typeof record.call_id === "string" ? record.call_id : null,
  };
}

async function makeContext(
  session: Session,
  summary = "private fixture summary",
  overrides: Partial<CompactionContext> = {},
): Promise<CompactionContext> {
  const projection = await buildHistoryProjection(session.deriveMessages(), {
    attachments: attachments(),
  });
  const history: CompactionHistoryItem[] = projection.items.map(
    ({ item }, index) => ({
      origin: identity(index, item),
      item: item as unknown as Record<string, unknown>,
    }),
  );
  return {
    after_model_call_index: 2,
    phase: "pre_turn",
    trigger: "manual",
    active_context_tokens: 10_000,
    context_window_tokens: 272_000,
    auto_compact_token_limit: 240_000,
    history_revision: 4,
    operation_id: "compaction-fixture-operation",
    history,
    summary,
    ...overrides,
  };
}

async function fixture(
  id: string,
  estimateMessage: (message: Message) => number = textLength,
) {
  const root = new Context();
  const sessions = root.plugin(SessionStore);
  await sessions;
  root.provide("attachments", attachments());
  root.provide("tokenMeter", {
    estimateMessage,
  } as unknown as Context["tokenMeter"]);
  const preparation = SessionPreparation.create(
    root.sessions.prepare(SessionId(id)),
  );
  return { root, sessions, preparation, session: preparation.session };
}

async function close(
  value: Awaited<ReturnType<typeof fixture>>,
): Promise<void> {
  value.preparation[Symbol.dispose]();
  await value.sessions.dispose();
}

function appendRound(
  session: Session,
  turn: number,
  options: {
    readonly user?: string;
    readonly userContent?: ContentBlock[];
    readonly pluginText?: string;
    readonly assistant?: string;
    readonly assistantContent?: ContentBlock[];
    readonly toolCallId?: ToolCallId;
  } = {},
): void {
  session.append("turn/start", { turn });
  session.append("step/start", { turn, step: 1 });
  session.append(
    "user/message",
    createUserMessage({
      content: options.userContent ?? [
        { type: "text", text: options.user ?? `user-${turn}` },
      ],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  if (options.pluginText !== undefined) {
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: options.pluginText }],
        source: { kind: "plugin", plugin: "dsh-hindsight" },
      }),
      { surfaceOp: "append" },
    );
  }
  const assistantEvent = session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: options.assistantContent ?? [
          { type: "text", text: options.assistant ?? `assistant-${turn}` },
        ],
        source: { provider: "openai", model: "gpt-5.6-sol" },
      }),
    },
    { surfaceOp: "append" },
  );
  if (options.toolCallId !== undefined) {
    session.append(
      "tool/result",
      {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId: options.toolCallId,
          content: [{ type: "text", text: "tool output" }],
          isError: false,
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [assistantEvent.seq] },
    );
  }
  session.append("step/end", { turn, step: 1 });
  session.append("turn/end", { turn, reason: { kind: "completed" } });
}

function appendOpenRound(
  session: Session,
  turn: number,
  content: ContentBlock[],
): void {
  session.append("turn/start", { turn });
  session.append("step/start", { turn, step: 1 });
  session.append(
    "user/message",
    createUserMessage({ content, source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
}

function historyText(item: CompactionHistoryItem["item"]): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) {
        return [];
      }
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

describe("Nanocodex host-selected compaction policy", () => {
  it("keeps the newest five complete rounds and preserves their order", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000501",
      () => 1,
    );
    try {
      for (
        let turn = 1;
        turn <= COMPACTION_VISIBLE_ROUND_LIMIT + 1;
        turn += 1
      ) {
        appendRound(value.session, turn);
      }
      const nodes = [...value.session.surface.nodes];
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );

      expect(plan.segments).toHaveLength(1);
      expect(plan.segments[0]?.shadowedSeqs).toEqual(nodes.slice(0, 2));
      expect(plan.shadowedSeqs).toEqual(nodes.slice(0, 2));
      expect(
        plan.decision.history
          .filter((item) => item.kind === "original")
          .map((item) => item.origin.index),
      ).toEqual(Array.from({ length: 10 }, (_, index) => index + 2));
    } finally {
      await close(value);
    }
  });

  it("does not prune a conversation with fewer than five complete rounds", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000502",
      () => 1,
    );
    try {
      appendRound(value.session, 1);
      appendRound(value.session, 2);
      appendRound(value.session, 3);
      const nodes = [...value.session.surface.nodes];
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );

      expect(plan.segments).toEqual([]);
      expect(plan.shadowedSeqs).toEqual([]);
      expect(plan.decision.history).toHaveLength(context.history.length + 1);
      expect(nodes).toEqual(value.session.surface.nodes);
    } finally {
      await close(value);
    }
  });

  it("keeps filtered replacements for a short mixed round", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000508",
      textLength,
    );
    try {
      appendRound(value.session, 1, {
        userContent: [
          { type: "text", text: "mixed user input" },
          { type: "image", attachment: imageRef },
        ],
        assistantContent: [
          { type: "reasoning", text: "private reasoning" },
          { type: "text", text: "visible assistant answer" },
        ],
      });
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );

      expect(plan.segments.map((segment) => segment.kind)).toEqual([
        "replace",
        "replace",
      ]);
      expect(plan.shadowedSeqs).toEqual([...value.session.surface.nodes]);
      expect(plan.segments.map((segment) => segment.message?.content)).toEqual([
        [{ type: "text", text: "mixed user input" }],
        [{ type: "text", text: "visible assistant answer" }],
      ]);
      expect(
        plan.decision.history
          .filter((item) => item.kind === "item")
          .map((item) => item.item),
      ).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "mixed user input" }],
          status: "completed",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible assistant answer" }],
          status: "completed",
        },
      ]);
      expect(JSON.stringify(plan.decision)).not.toContain("private reasoning");
      expect(JSON.stringify(plan.decision)).not.toContain("input_image");
    } finally {
      await close(value);
    }
  });

  it("preserves quoted markers in mapped messages and filters only unmapped engine context", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000509",
      textLength,
    );
    try {
      const selectedMarker =
        "Selected quote: # AGENTS.md instructions <environment_context> <compacted-summary>";
      const pendingMarker =
        "Pending quote: # AGENTS.md instructions <environment_context> <compacted_summary>";
      appendRound(value.session, 1, {
        user: selectedMarker,
        assistant: "selected response",
      });
      appendOpenRound(value.session, 2, [
        { type: "text", text: pendingMarker },
      ]);
      const context = await makeContext(value.session);
      const engineContext = {
        origin: {
          index: context.history.length,
          kind: "message",
          id: null,
          call_id: null,
        },
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "engine-owned canonical context" },
          ],
          status: "completed",
        } as Record<string, unknown>,
      } satisfies CompactionHistoryItem;
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        { ...context, history: [...context.history, engineContext] },
        value.root,
        new AbortController().signal,
      );
      const originals = plan.decision.history.flatMap((item) =>
        item.kind === "original"
          ? [historyText(context.history[item.origin.index]!.item)]
          : [],
      );

      expect(originals).toContain(selectedMarker);
      expect(originals).toContain(pendingMarker);
      expect(
        plan.decision.history.some(
          (item) =>
            item.kind === "original" &&
            item.origin.index === engineContext.origin.index,
        ),
      ).toBe(false);
    } finally {
      await close(value);
    }
  });

  it("uses the soft budget at whole-round boundaries and keeps one oversize newest round intact", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000503",
      textLength,
    );
    try {
      appendRound(value.session, 1, {
        user: "old-user",
        assistant: "old-assistant",
      });
      appendRound(value.session, 2, {
        user: "x".repeat(COMPACTION_VISIBLE_TOKEN_BUDGET + 100),
        assistant: "latest",
      });
      const nodes = [...value.session.surface.nodes];
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );

      expect(plan.segments[0]?.shadowedSeqs).toEqual(nodes.slice(0, 2));
      expect(
        plan.decision.history
          .filter((item) => item.kind === "original")
          .map((item) => historyText(context.history[item.origin.index]!.item)),
      ).toEqual(["x".repeat(COMPACTION_VISIBLE_TOKEN_BUDGET + 100), "latest"]);
    } finally {
      await close(value);
    }
  });

  it("removes historical plugin and tool material while retaining visible text", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000504",
      textLength,
    );
    try {
      for (let turn = 1; turn <= 5; turn += 1) appendRound(value.session, turn);
      const callId = ToolCallId("compaction-tool");
      appendRound(value.session, 6, {
        pluginText: "synthetic recall that is not user testimony",
        assistantContent: [
          { type: "text", text: "visible before tool" },
          {
            type: "tool-call",
            id: callId,
            name: "exec",
            arguments: JSON.stringify({ code: "return 1" }),
          },
          { type: "text", text: "visible after tool" },
        ],
        toolCallId: callId,
      });
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );
      const installedKinds = plan.decision.history.map((item) => item.kind);
      const newItems = plan.decision.history.flatMap((item) =>
        item.kind === "item" ? [item] : [],
      );

      expect(installedKinds[0]).toBe("summary");
      expect(newItems).toHaveLength(1);
      expect(historyText(newItems[0]!.item)).toBe(
        "visible before tool\nvisible after tool",
      );
      expect(
        plan.decision.history
          .filter((item) => item.kind === "original")
          .map((item) => context.history[item.origin.index]!.item.type),
      ).not.toContain("function_call");
      expect(
        plan.decision.history
          .filter((item) => item.kind === "original")
          .map((item) => context.history[item.origin.index]!.item.type),
      ).not.toContain("function_call_output");
      expect(plan.segments.some((segment) => segment.kind === "replace")).toBe(
        true,
      );
      const replacement = plan.segments.find(
        (segment) => segment.kind === "replace",
      )?.message;
      expect(replacement?.content).toEqual([
        { type: "text", text: "visible before tool" },
        { type: "text", text: "visible after tool" },
      ]);
      expect(plan.shadowedSeqs).toContain(
        [...value.session.surface.nodes].find(
          (seq) => value.session.eventAt(seq)?.type === "tool/result",
        ),
      );
    } finally {
      await close(value);
    }
  });

  it("keeps an open pending input and its attachment outside historical selection", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000505",
      textLength,
    );
    try {
      for (let turn = 1; turn <= 6; turn += 1) appendRound(value.session, turn);
      appendOpenRound(value.session, 7, [
        { type: "text", text: "pending with image" },
        { type: "image", attachment: imageRef },
      ]);
      const context = await makeContext(value.session);
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );
      const pending = context.history.at(-1)!;

      expect(plan.segments[0]?.shadowedSeqs).toEqual(
        [...value.session.surface.nodes].slice(0, 2),
      );
      expect(
        plan.decision.history.some(
          (item) =>
            item.kind === "original" &&
            item.origin.index === pending.origin.index,
        ),
      ).toBe(true);
      expect(historyText(pending.item)).toContain("pending with image");
      expect(JSON.stringify(pending.item)).toContain(
        "data:image/png;base64,AQID",
      );
    } finally {
      await close(value);
    }
  });

  it("keeps current supplementary context that is absent from pre-turn history", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000507",
      textLength,
    );
    try {
      for (let turn = 1; turn <= 6; turn += 1) appendRound(value.session, turn);
      appendOpenRound(value.session, 7, [
        { type: "text", text: "current input" },
      ]);
      value.session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "current supplementary context" }],
          source: { kind: "plugin", plugin: "dsh-hindsight" },
        }),
        { surfaceOp: "append" },
      );
      const fullContext = await makeContext(value.session);
      const preTurnProjection = await buildHistoryProjection(
        value.session.deriveMessages().slice(0, -1),
        { attachments: attachments() },
      );
      const context: CompactionContext = {
        ...fullContext,
        history: preTurnProjection.items.map(({ item }, index) => ({
          origin: identity(index, item),
          item: item as unknown as Record<string, unknown>,
        })),
      };
      const nodes = [...value.session.surface.nodes];
      const plan = await buildNanocodexCompactionPlan(
        value.session,
        context,
        value.root,
        new AbortController().signal,
      );

      expect(plan.segments[0]?.shadowedSeqs).toEqual(nodes.slice(0, 2));
      expect(plan.shadowedSeqs).not.toContain(nodes.at(-1));
      expect(plan.decision.history.map((item) => item.kind)).toContain(
        "original",
      );
    } finally {
      await close(value);
    }
  });

  it("rejects a changed supplied history instead of guessing provenance", async () => {
    const value = await fixture(
      "018f1f9a-7b3c-7a10-0000-000000000506",
      () => 1,
    );
    try {
      for (let turn = 1; turn <= 6; turn += 1) appendRound(value.session, turn);
      const context = await makeContext(value.session);
      const changed = [...context.history];
      changed[0] = {
        ...changed[0]!,
        item: {
          ...changed[0]!.item,
          content: [{ type: "input_text", text: "tampered" }],
        },
      };
      await expect(
        buildNanocodexCompactionPlan(
          value.session,
          { ...context, history: changed },
          value.root,
          new AbortController().signal,
        ),
      ).rejects.toThrow("does not match the active DSH surface");
    } finally {
      await close(value);
    }
  });

  it("does not turn the model-only DSH placeholder into history", () => {
    const placeholder = createUserMessage({
      content: [],
      source: { kind: "plugin", plugin: "dsh-nanocodex" },
    });
    expect(isNanocodexSurfacePlaceholder(placeholder)).toBe(true);
  });
});
