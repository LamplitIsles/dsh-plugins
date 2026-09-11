import { Context } from "@deepseek-ai/cordis";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import {
  Session,
  SessionId,
  SessionPreparation,
  SessionStore,
  type SessionSeq,
} from "@deepseek-ai/dsh-session";
import type { CompactionOutcome, HistoryItem } from "nanocodex/node";
import { describe, expect, it } from "vitest";
import { buildHistorySeed } from "../src/history.js";
import { APPLY_PATCH_NAME } from "../src/constants.js";
import { NanocodexEngine } from "../src/engine.js";

function outcomeFor(
  retained: CompactionOutcome["retained_tail"],
  history: readonly HistoryItem[],
): CompactionOutcome {
  return {
    revision: "mapping-fixture",
    trigger: "automatic",
    summary: "private fixture summary",
    replaced_history: { start: 0, end: retained[0]!.index },
    retained_tail: retained,
    context: { workspace: ".", history },
  };
}

describe("Nanocodex compaction history mapping", () => {
  it("maps repeated user text by the retained occurrence index", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000299")),
    );
    try {
      const session = preparation.session;
      for (const text of ["repeat", "middle", "repeat"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      }
      const history = (await buildHistorySeed(session.deriveMessages(), root))
        .history;
      const latest = { ...history[2]!, id: "engine-assigned-latest-user-id" };
      const outcome = outcomeFor(
        [{ index: 2, kind: "message", id: latest.id, call_id: null }],
        [latest],
      );

      const selection = await new NanocodexEngine(root).mapCompactionOutcome(
        { session },
        outcome,
        new AbortController().signal,
      );

      expect(selection.shadowedSeqs).toEqual(
        [...session.surface.nodes].slice(0, 2),
      );
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("keeps a pre-turn repeated input outside the admitted boundary", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000304")),
    );
    try {
      const session = preparation.session;
      const user = (text: string) =>
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      const reply = () =>
        session.append(
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: "text", text: "same reply" }],
              source: { provider: "openai", model: "gpt-5.6-sol" },
            }),
          },
          { surfaceOp: "append" },
        );
      user("old prefix");
      user("repeat");
      reply();
      session.append("step/start", { turn: 2, step: 1 });
      user("repeat");
      reply();

      const nodes = [...session.surface.nodes];
      const selection = await new NanocodexEngine(root).mapCompactionOutcome(
        { session },
        outcomeFor(
          [
            {
              index: 1,
              kind: "message",
              id: "engine-retained-user",
              call_id: null,
            },
            {
              index: 2,
              kind: "message",
              id: "engine-retained-assistant",
              call_id: null,
            },
          ],
          [
            {
              type: "message",
              role: "developer",
              content: [
                { type: "input_text", text: "private fixture summary" },
              ],
            },
            {
              type: "message",
              role: "user",
              id: "engine-retained-user",
              content: [{ type: "input_text", text: "repeat" }],
            },
            {
              type: "message",
              role: "assistant",
              id: "engine-retained-assistant",
              content: [{ type: "output_text", text: "same reply" }],
            },
          ],
        ),
        new AbortController().signal,
        {
          phase: "pre_turn",
          afterModelCallIndex: 0,
          admittedSurfaceSeqs: nodes.slice(0, 3),
        },
      );

      expect(selection.shadowedSeqs).toEqual([nodes[0]]);
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("maps a retained tail after the installed summary prefix", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000302")),
    );
    try {
      const session = preparation.session;
      for (const text of ["old1", "old2", "old3", "old4", "old5"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      }
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "latest" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "recall context" }],
          source: { kind: "plugin", plugin: "dsh-hindsight" },
        }),
        { surfaceOp: "append" },
      );
      session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: "text", text: "reply" }],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );

      const retained = [
        { index: 5, kind: "message", id: "engine-user", call_id: null },
        {
          index: 6,
          kind: "message",
          id: "engine-assistant",
          call_id: null,
        },
      ] as const;
      const contextHistory = [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<compacted-summary>private fixture summary</compacted-summary>",
            },
          ],
        },
        {
          type: "message",
          role: "user",
          id: "engine-user",
          content: [
            { type: "input_text", text: "latest" },
            { type: "input_text", text: "recall context" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          id: "engine-assistant",
          content: [
            {
              type: "output_text",
              text: "reply",
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ] as unknown as HistoryItem[];
      const outcome = outcomeFor(retained, contextHistory);
      const selection = await new NanocodexEngine(root).mapCompactionOutcome(
        { session },
        outcome,
        new AbortController().signal,
      );

      expect(selection.shadowedSeqs).toEqual(
        [...session.surface.nodes].slice(0, 5),
      );

      const mismatchedHistory = [...contextHistory];
      mismatchedHistory[2] = {
        ...mismatchedHistory[2]!,
        content: [
          {
            type: "output_text",
            text: "changed",
            annotations: [],
            logprobs: [],
          },
        ],
      } as unknown as HistoryItem;
      await expect(
        new NanocodexEngine(root).mapCompactionOutcome(
          { session },
          outcomeFor(retained, mismatchedHistory),
          new AbortController().signal,
        ),
      ).rejects.toThrow("retained history order");
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("maps the latest of repeated warm supplementary groups", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000303")),
    );
    try {
      const session = preparation.session;
      for (const name of ["old", "latest"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: name }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: `${name} recall` }],
            source: { kind: "plugin", plugin: "dsh-hindsight" },
          }),
          { surfaceOp: "append" },
        );
        session.append(
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: "text", text: `${name} reply` }],
              source: { provider: "openai", model: "gpt-5.6-sol" },
            }),
          },
          { surfaceOp: "append" },
        );
      }

      const selection = await new NanocodexEngine(root).mapCompactionOutcome(
        { session },
        outcomeFor(
          [
            { index: 2, kind: "message", id: "engine-user", call_id: null },
            {
              index: 3,
              kind: "message",
              id: "engine-assistant",
              call_id: null,
            },
          ],
          [
            {
              type: "message",
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: "<compacted-summary>private fixture summary</compacted-summary>",
                },
              ],
            },
            {
              type: "message",
              role: "user",
              id: "engine-user",
              content: [
                { type: "input_text", text: "latest" },
                { type: "input_text", text: "latest recall" },
              ],
            },
            {
              type: "message",
              role: "assistant",
              id: "engine-assistant",
              content: [{ type: "output_text", text: "latest reply" }],
            },
          ],
        ),
        new AbortController().signal,
      );

      expect(selection.shadowedSeqs).toEqual(
        [...session.surface.nodes].slice(0, 3),
      );
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("validates ordered retained tool history against its indexed projection", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000300")),
    );
    try {
      const session = preparation.session;
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "first" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      const callId = ToolCallId("mapping-call");
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "second" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      const callEvent = session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              {
                type: "tool-call",
                id: callId,
                name: "roll_dice",
                arguments: "{}",
              },
            ],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );
      session.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: "text", text: '{"total":4}' }],
            isError: false,
          }),
        },
        { surfaceOp: "append", sourceEventSeqs: [callEvent.seq] },
      );
      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "third" }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      const history = (await buildHistorySeed(session.deriveMessages(), root))
        .history;
      const retained = history.slice(1).map((item, index) => ({
        index: index + 1,
        kind: item.type,
        id: item.id ?? null,
        call_id: "call_id" in item ? item.call_id : null,
      }));
      const selection = await new NanocodexEngine(root).mapCompactionOutcome(
        { session },
        outcomeFor(retained, history.slice(1)),
        new AbortController().signal,
      );

      expect(selection.shadowedSeqs).toEqual([session.surface.nodes[0]]);
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it.each(["apply_patch", "exec"])(
    "maps a surfaced %s custom exchange without replaying it",
    async (name) => {
      const root = new Context();
      const sessions = root.plugin(SessionStore);
      await sessions;
      const preparation = SessionPreparation.create(
        root.sessions.prepare(
          SessionId("018f1f9a-7b3c-7a10-8000-000000000308"),
        ),
      );
      try {
        const session = preparation.session;
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: "old prefix" }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text: "update the file" }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
        const patchCallId = ToolCallId("direct-patch-call");
        const input =
          name === "exec"
            ? 'text("Applied 1 file.");'
            : "*** Begin Patch\n*** End Patch\n";
        const patchArguments = JSON.stringify({
          [name === "exec" ? "code" : "patch"]: input,
        });
        const callEvent = session.append(
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [
                {
                  type: "tool-call",
                  id: patchCallId,
                  name,
                  arguments: patchArguments,
                },
              ],
              source: { provider: "openai", model: "gpt-5.6-sol" },
            }),
          },
          { surfaceOp: "append" },
        );
        session.append("tool/call", {
          turn: 1,
          step: 1,
          callId: patchCallId,
          name,
          arguments: patchArguments,
        });
        session.append(
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
              callId: patchCallId,
              content: [{ type: "text", text: "Applied 1 file." }],
              isError: false,
            }),
          },
          { surfaceOp: "append", sourceEventSeqs: [callEvent.seq] },
        );

        const outcome = outcomeFor(
          [
            { index: 1, kind: "message", id: "engine-user", call_id: null },
            {
              index: 2,
              kind: "custom_tool_call",
              id: "engine-patch-call",
              call_id: "direct-patch-call",
            },
            {
              index: 3,
              kind: "custom_tool_call_output",
              id: null,
              call_id: "direct-patch-call",
            },
          ],
          [
            {
              type: "message",
              role: "developer",
              content: [
                { type: "input_text", text: "private fixture summary" },
              ],
            },
            {
              type: "message",
              role: "user",
              id: "engine-user",
              content: [{ type: "input_text", text: "update the file" }],
            },
            {
              type: "custom_tool_call",
              id: "engine-patch-call",
              call_id: "direct-patch-call",
              name,
              input,
            },
            {
              type: "custom_tool_call_output",
              call_id: "direct-patch-call",
              name,
              output: "Applied 1 file.",
            },
          ],
        );

        const engine = new NanocodexEngine(root);
        const selection = await engine.mapCompactionOutcome(
          { session },
          outcome,
          new AbortController().signal,
        );
        expect(selection.shadowedSeqs).toEqual([session.surface.nodes[0]]);
      } finally {
        preparation[Symbol.dispose]();
        await sessions.dispose();
      }
    },
  );

  it("maps parallel direct patches and rejects a dangling retained pair", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000309")),
    );
    try {
      const session = preparation.session;
      for (const text of ["old prefix", "apply two patches"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      }
      const patch = (name: string) =>
        JSON.stringify({
          patch: `*** Begin Patch\n*** Add File: ${name}.txt\n+${name}\n*** End Patch\n`,
        });
      const callIds = [ToolCallId("patch-a"), ToolCallId("patch-b")] as const;
      const callEvent = session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: callIds.map((id) => ({
              type: "tool-call" as const,
              id,
              name: APPLY_PATCH_NAME,
              arguments: patch(String(id)),
            })),
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );
      for (const callId of callIds) {
        session.append("tool/call", {
          turn: 1,
          step: 1,
          callId,
          name: APPLY_PATCH_NAME,
          arguments: patch(String(callId)),
        });
      }
      for (const callId of [...callIds].reverse()) {
        session.append(
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
              callId,
              content: [{ type: "text", text: `Applied ${String(callId)}.` }],
              isError: false,
            }),
          },
          { surfaceOp: "append", sourceEventSeqs: [callEvent.seq] },
        );
      }

      const retained = [
        { index: 1, kind: "message", id: "engine-user", call_id: null },
        {
          index: 2,
          kind: "custom_tool_call",
          id: "engine-patch-a",
          call_id: "patch-a",
        },
        {
          index: 3,
          kind: "custom_tool_call",
          id: "engine-patch-b",
          call_id: "patch-b",
        },
        {
          index: 4,
          kind: "custom_tool_call_output",
          id: null,
          call_id: "patch-b",
        },
        {
          index: 5,
          kind: "custom_tool_call_output",
          id: null,
          call_id: "patch-a",
        },
      ] as const;
      const contextHistory: HistoryItem[] = [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "private fixture summary" }],
        },
        {
          type: "message",
          role: "user",
          id: "engine-user",
          content: [{ type: "input_text", text: "apply two patches" }],
        },
        {
          type: "custom_tool_call",
          id: "engine-patch-a",
          call_id: "patch-a",
          name: APPLY_PATCH_NAME,
          input:
            "*** Begin Patch\n*** Add File: patch-a.txt\n+patch-a\n*** End Patch\n",
        },
        {
          type: "custom_tool_call",
          id: "engine-patch-b",
          call_id: "patch-b",
          name: APPLY_PATCH_NAME,
          input:
            "*** Begin Patch\n*** Add File: patch-b.txt\n+patch-b\n*** End Patch\n",
        },
        {
          type: "custom_tool_call_output",
          call_id: "patch-b",
          name: APPLY_PATCH_NAME,
          output: "Applied patch-b.",
        },
        {
          type: "custom_tool_call_output",
          call_id: "patch-a",
          name: APPLY_PATCH_NAME,
          output: "Applied patch-a.",
        },
      ];
      const outcome = outcomeFor(retained, contextHistory);
      const engine = new NanocodexEngine(root);
      await expect(
        engine.mapCompactionOutcome(
          { session },
          outcome,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        shadowedSeqs: [session.surface.nodes[0]],
      });

      const incompleteRetained = retained
        .filter(
          (item) =>
            item.call_id !== "patch-b" ||
            item.kind !== "custom_tool_call_output",
        )
        .map((item, index) => ({ ...item, index: index + 1 }));
      const incompleteContext = contextHistory.filter(
        (item) =>
          !(
            item.type === "custom_tool_call_output" &&
            item.call_id === "patch-b"
          ),
      );
      await expect(
        engine.mapCompactionOutcome(
          { session },
          outcomeFor(incompleteRetained, incompleteContext),
          new AbortController().signal,
        ),
      ).rejects.toThrow("apply_patch call without a result");
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("maps a persisted outer Code Mode pair through its child tools", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000305")),
    );
    try {
      const session = preparation.session;
      const childCallId = ToolCallId(
        `call-exec-child-patch|ctc_${"a".repeat(50)}`,
      );
      const patch = "*** Begin Patch\n*** End Patch\n";
      for (const text of ["old prefix", "apply a patch"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      }
      const callEvent = session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [
              {
                type: "tool-call",
                id: childCallId,
                name: APPLY_PATCH_NAME,
                arguments: JSON.stringify({ patch }),
              },
            ],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );
      session.append("tool/call", {
        turn: 1,
        step: 1,
        callId: childCallId,
        name: APPLY_PATCH_NAME,
        arguments: JSON.stringify({ patch }),
      });
      session.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: childCallId,
            content: [{ type: "text", text: "Applied 1 file." }],
            isError: false,
          }),
        },
        { surfaceOp: "append", sourceEventSeqs: [callEvent.seq] },
      );
      session.append("tool/code-dispatch-start", {
        rootCallId: ToolCallId("call-exec"),
        parentCallId: ToolCallId("call-exec"),
        subCallId: childCallId,
        name: APPLY_PATCH_NAME,
        arguments: { patch },
      });
      session.append("tool/code-dispatch", {
        rootCallId: ToolCallId("call-exec"),
        parentCallId: ToolCallId("call-exec"),
        subCallId: childCallId,
        name: APPLY_PATCH_NAME,
        arguments: { patch },
        isError: false,
        content: [{ type: "text", text: "Applied 1 file." }],
      });
      session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: "text", text: "The patch was applied." }],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );

      const outcome = outcomeFor(
        [
          { index: 1, kind: "message", id: "engine-user", call_id: null },
          {
            index: 2,
            kind: "custom_tool_call",
            id: "tool-exec",
            call_id: "call-exec",
          },
          {
            index: 3,
            kind: "custom_tool_call_output",
            id: null,
            call_id: "call-exec",
          },
          {
            index: 4,
            kind: "message",
            id: "engine-assistant",
            call_id: null,
          },
        ],
        [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "private fixture summary" }],
          },
          {
            type: "message",
            role: "user",
            id: "engine-user",
            content: [{ type: "input_text", text: "apply a patch" }],
          },
          {
            type: "custom_tool_call",
            id: "tool-exec",
            call_id: "call-exec",
            name: "exec",
            input: "text(await tools.roll_dice({sides:6}));",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call-exec",
            output: "Applied 1 file.",
          },
          {
            type: "message",
            role: "assistant",
            id: "engine-assistant",
            content: [{ type: "output_text", text: "The patch was applied." }],
          },
        ],
      );
      const restored = Session.create(
        session.id,
        session.snapshotEvents(),
        session.header,
        session.inheritedEventCount,
      );
      const engine = new NanocodexEngine(root);
      await expect(
        engine.mapCompactionOutcome(
          { session: restored },
          outcome,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        shadowedSeqs: [session.surface.nodes[0]],
      });

      const mismatchedEvents = session.snapshotEvents().map((event) =>
        event.type === "tool/code-dispatch"
          ? {
              ...event,
              data: {
                ...event.data,
                subCallId: ToolCallId("wrong-child-id"),
              },
            }
          : event,
      );
      const mismatched = Session.create(
        session.id,
        mismatchedEvents,
        session.header,
        session.inheritedEventCount,
      );
      await expect(
        engine.mapCompactionOutcome(
          { session: mismatched },
          outcome,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Code Mode child tool association is incomplete");
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("maps parallel Code Mode children by durable start and settle order", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000307")),
    );
    try {
      const session = preparation.session;
      const childIds = ["parallel-a", "parallel-b"] as const;
      const callEvents = new Map<string, { readonly seq: SessionSeq }>();
      const contentFor = (id: string) => [
        { type: "text" as const, text: `{"result":"${id}"}` },
      ];
      for (const text of ["old prefix", "parallel roll"]) {
        session.append(
          "user/message",
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
          { surfaceOp: "append" },
        );
      }
      for (const id of childIds) {
        const childCallId = ToolCallId(id);
        const callEvent = session.append(
          "assistant/message",
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [
                {
                  type: "tool-call",
                  id: childCallId,
                  name: "roll_dice",
                  arguments: '{"sides":6}',
                },
              ],
              source: { provider: "openai", model: "gpt-5.6-sol" },
            }),
          },
          { surfaceOp: "append" },
        );
        callEvents.set(id, callEvent);
        session.append("tool/call", {
          turn: 1,
          step: 1,
          callId: childCallId,
          name: "roll_dice",
          arguments: '{"sides":6}',
        });
        session.append("tool/code-dispatch-start", {
          rootCallId: ToolCallId("call-exec"),
          parentCallId: ToolCallId("call-exec"),
          subCallId: childCallId,
          name: "roll_dice",
          arguments: { sides: 6 },
        });
      }
      for (const id of [...childIds].reverse()) {
        const childCallId = ToolCallId(id);
        session.append(
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
              callId: childCallId,
              content: contentFor(id),
              isError: false,
            }),
          },
          {
            surfaceOp: "append",
            sourceEventSeqs: [callEvents.get(id)!.seq],
          },
        );
        session.append("tool/code-dispatch", {
          rootCallId: ToolCallId("call-exec"),
          parentCallId: ToolCallId("call-exec"),
          subCallId: childCallId,
          name: "roll_dice",
          arguments: { sides: 6 },
          isError: false,
          content: contentFor(id),
        });
      }
      session.append(
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: "text", text: "Parallel rolls completed." }],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );

      const outcome = outcomeFor(
        [
          { index: 1, kind: "message", id: "engine-user", call_id: null },
          {
            index: 2,
            kind: "custom_tool_call",
            id: "tool-exec",
            call_id: "call-exec",
          },
          {
            index: 3,
            kind: "custom_tool_call_output",
            id: null,
            call_id: "call-exec",
          },
          {
            index: 4,
            kind: "message",
            id: "engine-assistant",
            call_id: null,
          },
        ],
        [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "private fixture summary" }],
          },
          {
            type: "message",
            role: "user",
            id: "engine-user",
            content: [{ type: "input_text", text: "parallel roll" }],
          },
          {
            type: "custom_tool_call",
            id: "tool-exec",
            call_id: "call-exec",
            name: "exec",
            input:
              "text(await Promise.all([tools.roll_dice({sides:6}), tools.roll_dice({sides:6})]));",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call-exec",
            output: '{"result":"parallel"}',
          },
          {
            type: "message",
            role: "assistant",
            id: "engine-assistant",
            content: [
              { type: "output_text", text: "Parallel rolls completed." },
            ],
          },
        ],
      );
      const restored = Session.create(
        session.id,
        session.snapshotEvents(),
        session.header,
        session.inheritedEventCount,
      );
      const engine = new NanocodexEngine(root);
      await expect(
        engine.mapCompactionOutcome(
          { session: restored },
          outcome,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({
        shadowedSeqs: [session.surface.nodes[0]],
      });

      const invalidEvents = session.snapshotEvents().map((event) =>
        event.type === "tool/code-dispatch" &&
        String(event.data.subCallId) === "parallel-b"
          ? {
              ...event,
              data: {
                ...event.data,
                content: contentFor("changed"),
              },
            }
          : event,
      );
      const invalid = Session.create(
        session.id,
        invalidEvents,
        session.header,
        session.inheritedEventCount,
      );
      await expect(
        engine.mapCompactionOutcome(
          { session: invalid },
          outcome,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Code Mode child tool does not match the DSH pair");
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });
});
