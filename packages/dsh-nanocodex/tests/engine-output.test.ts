import { memoryCheckpoints } from "./checkpoint-store-fixture.js";
import { Context } from "@deepseek-ai/cordis";
import type { Agent as DshAgent } from "@deepseek-ai/dsh-agent";
import {
  AttachmentError,
  type AttachmentStore,
} from "@deepseek-ai/dsh-attachment";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import { deriveTurnTokenUsage } from "@deepseek-ai/dsh-token-meter/client";
import { Agent, type AgentEvent, type NamedTool } from "nanocodex/node";
import { expect, it, vi } from "vitest";
import { NanocodexEngine } from "../src/engine.js";
import { buildHistorySeed } from "../src/history.js";

vi.mock("nanocodex/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanocodex/node")>();
  return {
    ...actual,
    Agent: { ...actual.Agent, create: vi.fn<typeof actual.Agent.create>() },
  };
});

const texts = [
  "I will inspect this first.",
  "I found the cause.",
  "Here is the final answer.",
];
const tool = {
  name: "fixture_tool",
  description: "Fixture tool",
  parameters: { type: "object", properties: {} },
  output: { schema: {} },
};

type ReplayMode = "deltas" | "completed-messages" | "completed-response";

async function replay(
  mode: ReplayMode,
  failure?: "cancelled" | "invalid-image",
) {
  const root = new Context();
  const sessions = root.plugin(SessionStore);
  await sessions;
  root.provide("settings", {
    get: () => ({ providers: { openai: { apiKeyEnv: "FIXTURE" } } }),
  });
  root.provide("credentials", {
    resolve: async () => ({ value: "unused-fixture" }),
  });
  const execute = vi.fn<ToolRuntime["execute"]>(async () => ({
    isError: false,
    value: "tool result",
    content: [{ type: "text", text: "tool result" }],
  }));
  root.provide("attachments", {
    saveImages: async () => {
      throw new AttachmentError(
        "Unsupported or malformed image data.",
        "INVALID_IMAGE",
      );
    },
  });
  root.provide("tools", {
    schemas: () => [tool],
    get: () => tool,
    execute,
  });
  const preparation = SessionPreparation.create(
    root.sessions.prepare(
      SessionId("session-018f1f9a-7b3c-7a10-8000-000000000399"),
    ),
  );
  const session = preparation.session;
  const listeners = new Set<(event: AgentEvent) => void>();
  let eventSeq = 0;
  const emit = (type: string, payload: Record<string, unknown>) => {
    const event = {
      protocol_version: 1,
      request_id: "fixture",
      seq: eventSeq++,
      type,
      payload,
    };
    for (const listener of listeners) listener(event);
  };
  let options: Parameters<typeof Agent.create>[0];
  let cancelTurn!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelTurn = resolve;
  });
  const create = vi.mocked(Agent.create).mockImplementation(async (value) => {
    options = value;
    return {
      events: {
        watch: () => ({
          onEvent: (listener: (event: AgentEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          off() {},
        }),
      },
      turn: {
        prompt: () => ({
          accepted: async () => {},
          cancel: async () => {
            cancelTurn();
          },
          dispose() {},
          result: async () => {
            for (const [index, text] of texts.entries()) {
              const callIndex = index + 1;
              const message = {
                type: "message",
                id: `msg_${index}`,
                role: "assistant",
                content: [{ type: "output_text", text }],
              };
              const parent = {
                type: "custom_tool_call",
                id: `ctc_${index}`,
                call_id: `exec_${index}`,
                name: "exec",
                input:
                  index === 0
                    ? "text(await tools.fixture_tool({})); text(await tools.fixture_tool({}));"
                    : 'text("intermediate result");',
              };
              const output = index < 2 ? [message, parent] : [message];
              const usage = {
                input_tokens: callIndex * 100,
                input_tokens_details: {
                  cached_tokens: callIndex * 80,
                  cache_write_tokens: 0,
                },
                output_tokens: callIndex * 10,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: callIndex * 110,
              };
              emit("model.call.started", { call_index: callIndex });
              if (mode === "deltas") {
                emit("assistant.delta", {
                  model_call_index: callIndex,
                  item_id: message.id,
                  text: text.slice(0, 5),
                });
                emit("assistant.delta", {
                  model_call_index: callIndex,
                  item_id: message.id,
                  text: text.slice(5),
                });
              }
              if (mode !== "completed-response") {
                emit("assistant.message", {
                  model_call_index: callIndex,
                  item_id: message.id,
                  text,
                });
              }
              emit("api.event", {
                phase: "generation",
                model_call_index: callIndex,
                event: {
                  type: "response.completed",
                  response: { output, usage },
                },
              });
              emit("model.call.completed", { call_index: callIndex, usage });
              if (index < 2) {
                emit("tool.call", {
                  call_id: parent.call_id,
                  tool: "exec",
                  arguments: parent.input,
                  model_call_index: callIndex,
                });
                if (index === 0) {
                  for (const child of ["child_one", "child_two"]) {
                    const bridged = (options.tools as NamedTool[]).find(
                      (candidate) => candidate.name === tool.name,
                    )!;
                    await bridged.handler(
                      {},
                      {
                        callId: child,
                        parentCallId: parent.call_id,
                        sessionId: String(session.id),
                        model: "gpt-5.6-sol",
                        signal: new AbortController().signal,
                      },
                    );
                  }
                }
                if (failure === "cancelled")
                  throw new Error("the turn was cancelled");
                if (failure === "invalid-image") {
                  emit("tool.result", {
                    call_id: parent.call_id,
                    tool: "exec",
                    status: "completed",
                    result: [
                      {
                        type: "input_image",
                        image_url: "data:image/png;base64,dHJ1bmNhdGVk",
                      },
                    ],
                  });
                  await cancelled;
                  throw new Error("the turn was cancelled");
                }
                emit("tool.result", {
                  call_id: parent.call_id,
                  tool: "exec",
                  status: "completed",
                  result: "tool result",
                  structured_result: "tool result",
                });
              }
            }
            return {
              finalMessage: texts[2],
              snapshot: async () => ({}),
              dispose() {},
            };
          },
        }),
      },
      session: { shutdown: async () => {} },
      dispose() {},
    } as unknown as Awaited<ReturnType<typeof Agent.create>>;
  });
  const engine = new NanocodexEngine(root, memoryCheckpoints());
  const agent = {
    id: session.id,
    session,
    ctx: root,
    options: { provider: "openai", model: "gpt-5.6-sol" },
  } as unknown as DshAgent;
  const user = createUserMessage({
    content: [{ type: "text", text: "Investigate." }],
    source: { kind: "user" },
  });
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  session.append("user/message", user, { surfaceOp: "append" });
  let step = 1;
  let runError: unknown;
  try {
    await engine
      .run(
        agent,
        [],
        [user],
        {
          sections: [],
          contexts: [],
          tools: [tool],
          variables: {},
        },
        1,
        1,
        new AbortController().signal,
        () => {
          session.append("step/end", { turn: 1, step });
          step += 1;
          session.append("step/start", { turn: 1, step });
          return step;
        },
      )
      .catch((error: unknown) => {
        runError = error;
      });
    if (failure === undefined && runError !== undefined) throw runError;
    session.append("step/end", { turn: 1, step });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    return {
      events: session.snapshotEvents(),
      messages: session.deriveMessages(),
      executions: execute.mock.calls.length,
      runError,
    };
  } finally {
    await engine.invalidate(agent);
    create.mockReset();
    preparation[Symbol.dispose]();
    await sessions.dispose();
  }
}

it.each<ReplayMode>(["deltas", "completed-messages", "completed-response"])(
  "preserves prose, parent tools, and results in request order: %s",
  async (mode) => {
    const { messages, events, executions } = await replay(mode);
    const assistants = events.filter(
      (event) => event.type === "assistant/message",
    );
    expect(assistants.map((event) => event.data.step)).toEqual([1, 2, 3]);
    expect(
      assistants.map((event) =>
        event.data.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      ),
    ).toEqual(texts);
    expect(executions).toBe(2);
    const seed = await buildHistorySeed(messages, {
      attachments: {} as AttachmentStore,
    });
    expect(seed.history.map((item) => item.type)).toEqual([
      "message",
      "message",
      "custom_tool_call",
      "custom_tool_call_output",
      "message",
      "custom_tool_call",
      "custom_tool_call_output",
      "message",
    ]);
  },
);

it("gives the official turn disclosure complete totals and cache buckets", async () => {
  const { events } = await replay("deltas");
  expect(deriveTurnTokenUsage(events)).toEqual({
    uncachedInputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 480,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 660,
    routes: [{ provider: "openai", model: "gpt-5.6-sol" }],
  });
});

it.each(["cancelled", "invalid-image"] as const)(
  "keeps a failed exec recoverable without replaying its completed children: %s",
  async (failure) => {
    const { messages, events, executions, runError } = await replay(
      "completed-response",
      failure,
    );
    expect(runError).toBeInstanceOf(Error);
    expect((runError as Error).message).toBe(
      failure === "invalid-image"
        ? "Unsupported or malformed image data."
        : "the turn was cancelled",
    );
    expect(executions).toBe(2);
    const results = events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(1);
    expect(results[0]?.data.message.content).toMatchObject([
      { type: "tool-result", toolCallId: "exec_0", isError: true },
    ]);
    await expect(
      buildHistorySeed(messages, {} as { attachments: AttachmentStore }),
    ).resolves.toMatchObject({
      history: expect.arrayContaining([
        {
          type: "custom_tool_call_output",
          call_id: "exec_0",
          output: expect.stringMatching(/interrupted|failed/i),
        },
      ]),
    });
  },
);
