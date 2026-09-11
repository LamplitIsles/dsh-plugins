import { memoryCheckpoints } from "./checkpoint-store-fixture.js";
import { Context } from "@deepseek-ai/cordis";
import { toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import {
  createAssistantMessage,
  createUserMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import { expect, it } from "vitest";
import { NanocodexAgent } from "../src/agent.js";
import { NanocodexEngine } from "../src/engine.js";
import { buildHistorySeed } from "../src/history.js";
import { closeInterruptedToolCalls } from "../src/interrupted-tools.js";

it.each([true, false])(
  "recovers a closed failed turn and keeps compaction balanced (dispatch recorded: %s)",
  async (dispatched) => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000320")),
    );
    const session = preparation.session;
    const callId = ToolCallId("interrupted-exec");
    try {
      session.append("turn/start", { turn: 1 });
      session.append("step/start", { turn: 1, step: 1 });
      session.append(
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
                arguments: JSON.stringify({
                  code: "await tools.fixture_tool({});",
                }),
              },
            ],
            source: { provider: "openai", model: "gpt-5.6-sol" },
          }),
        },
        { surfaceOp: "append" },
      );
      if (dispatched)
        session.append("tool/call", {
          turn: 1,
          step: 1,
          callId,
          name: "exec",
          arguments: JSON.stringify({ code: "await tools.fixture_tool({});" }),
        });
      session.append("step/end", { turn: 1, step: 1 });
      session.append("turn/end", {
        turn: 1,
        reason: {
          kind: "error",
          error: { code: "UNKNOWN", message: "the turn was cancelled" },
        },
      });
      const original = session.snapshotEvents();

      // Loading the actual agent repairs history even when the old turn already
      // has a terminal error record and persistence's crash recovery is finished.
      const agent = new NanocodexAgent(
        root,
        session.id,
        {},
        session,
        new NanocodexEngine(root, memoryCheckpoints()),
      );
      const recovered = session.snapshotEvents();
      expect(recovered.slice(0, original.length)).toEqual(original);
      expect(
        recovered.filter((event) => event.type === "tool/call"),
      ).toHaveLength(1);
      const results = recovered.filter((event) => event.type === "tool/result");
      expect(results).toHaveLength(1);
      expect(results[0]?.data.message.content).toMatchObject([
        {
          type: "tool-result",
          toolCallId: callId,
          isError: true,
          content: [
            {
              type: "text",
              text: expect.stringMatching(/interrupted.*side effects/i),
            },
          ],
        },
      ]);
      expect(
        toolPairingBalancedAfter(session, session.surface.nodes.at(-1)!),
      ).toBe(true);
      closeInterruptedToolCalls(session);
      expect(session.snapshotEvents()).toEqual(recovered);

      session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: "Continue." }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      await expect(
        buildHistorySeed(session.deriveMessages(), root),
      ).resolves.toMatchObject({
        history: [
          { type: "custom_tool_call", call_id: callId },
          { type: "custom_tool_call_output", call_id: callId },
          { type: "message", role: "user" },
        ],
      });
      await agent.dispose();
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  },
);
