import {
  createAssistantMessageEventStream,
  registerSessionResourceCleanup,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  APPLY_PATCH_GRAMMAR,
  APPLY_PATCH_NAME,
  CODE_MODE_TOOL_DESCRIPTION,
  CODE_MODE_GRAMMAR,
  RUN_CODE_DESCRIPTION,
  RUN_CODE_NAME,
  type CodexSettings,
} from "../src/index.js";
import {
  createCodexProfile,
  createCodexProviderLifecycle,
  mapContextToCodex,
  mapEventsToCanonical,
} from "../src/provider.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "codex-code-mode",
    model: "gpt-5-codex",
    usage,
    stopReason: "pending",
    timestamp: 0,
  };
}

function runCodeTool(): PiTool {
  return {
    name: RUN_CODE_NAME,
    description: RUN_CODE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        description: { type: "string" },
      },
      required: ["code", "description"],
      additionalProperties: false,
    },
  } as PiTool;
}

function applyPatchTool(): PiTool {
  return {
    name: APPLY_PATCH_NAME,
    description: "Apply patch",
    parameters: {
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
      additionalProperties: false,
    },
  } as PiTool;
}

const settings: CodexSettings = {
  enabled: true,
  baseURL: "https://codex-gateway.test",
  credentialRef: "CODEX_API_KEY",
  models: [
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      contextWindow: 262_144,
      maxTokens: 32_768,
    },
  ],
  transport: "websocket-cached",
  maxPatchChars: 4_000_000,
  maxPatchFiles: 64,
  maxPatchFileBytes: 4_000_000,
};

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Codex provider mapping", () => {
  it("maps canonical history to one raw-input custom tool without mutating it", () => {
    const code = "return await tools.read({ path: 'README.md' });";
    const canonicalToolCall = {
      type: "toolCall" as const,
      id: "call-1|fc-1",
      name: RUN_CODE_NAME,
      arguments: { code, description: RUN_CODE_DESCRIPTION },
    };
    const otherToolCall = {
      type: "toolCall" as const,
      id: "call-2|fc-2",
      name: "ordinary_tool",
      arguments: { value: 1 },
    };
    const context: PiContext = {
      systemPrompt: "Use the existing DSH TypeScript SDK.",
      messages: [assistant([canonicalToolCall, otherToolCall])],
      tools: [
        runCodeTool(),
        applyPatchTool(),
        {
          name: "ordinary_tool",
          description: "An ordinary function tool",
          parameters: {
            type: "object",
            properties: { value: { type: "number" } },
          },
        } as PiTool,
      ],
    };
    const before = structuredClone(context);
    const mapped = mapContextToCodex(context);
    const mappedCall = mapped.messages[0];
    expect(mappedCall?.role).toBe("assistant");
    if (mappedCall?.role !== "assistant")
      throw new Error("expected assistant history");
    expect(mappedCall.content[0]).toMatchObject({
      type: "toolCall",
      id: canonicalToolCall.id,
      name: RUN_CODE_NAME,
      arguments: { input: code },
    });
    expect(mappedCall.content[1]).toEqual(otherToolCall);
    expect(mapped.tools?.[0]).toMatchObject({
      name: RUN_CODE_NAME,
      description: CODE_MODE_TOOL_DESCRIPTION,
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: CODE_MODE_GRAMMAR },
      },
      parameters: {
        type: "object",
        required: ["input"],
        additionalProperties: false,
        properties: { input: { type: "string" } },
      },
    });
    expect(mapped.tools).toHaveLength(2);
    expect(mapped.tools?.[1]).toMatchObject({
      name: APPLY_PATCH_NAME,
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: APPLY_PATCH_GRAMMAR },
      },
      parameters: {
        type: "object",
        required: ["input"],
        additionalProperties: false,
        properties: { input: { type: "string" } },
      },
    });
    expect(context).toEqual(before);
  });

  it.each([
    undefined,
    [],
    [
      {
        name: "ordinary_tool",
        description: "An ordinary function tool",
        parameters: { type: "object", properties: {} },
      },
    ],
  ])(
    "rejects code-mode mapping without the existing PTC run_code entry",
    (tools) => {
      const context: PiContext = {
        messages: [],
        ...(tools === undefined ? {} : { tools: tools as PiTool[] }),
      };
      expect(() => mapContextToCodex(context)).toThrow(
        "Codex code-mode requires the existing DSH PTC run_code tool",
      );
    },
  );

  it("rejects code-mode mapping when the direct patch registration is absent", () => {
    const context: PiContext = {
      messages: [],
      tools: [runCodeTool()],
    };
    expect(() => mapContextToCodex(context)).toThrow(
      "Codex code-mode requires the direct apply_patch tool registration",
    );
  });

  it("normalizes streamed custom-tool input to canonical run_code arguments", async () => {
    const code = "return await tools.a({ value: 1 });\nreturn await tools.b();";
    const source = createAssistantMessageEventStream();
    const initial = assistant([
      {
        type: "toolCall",
        id: "call-1|ctc-1",
        name: RUN_CODE_NAME,
        arguments: { input: "" },
      },
    ]);
    source.push({ type: "toolcall_start", contentIndex: 0, partial: initial });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "ignored wire delta",
      partial: assistant([
        {
          type: "toolCall",
          id: "call-1|ctc-1",
          name: RUN_CODE_NAME,
          arguments: { input: code.slice(0, 31) },
        },
      ]),
    });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "ignored wire delta",
      partial: assistant([
        {
          type: "toolCall",
          id: "call-1|ctc-1",
          name: RUN_CODE_NAME,
          arguments: { input: code },
        },
      ]),
    });
    const complete = assistant([
      {
        type: "toolCall",
        id: "call-1|ctc-1",
        name: RUN_CODE_NAME,
        arguments: { input: code },
      },
    ]);
    source.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: complete.content[0] as Extract<
        AssistantMessage["content"][number],
        { type: "toolCall" }
      >,
      partial: complete,
    });
    source.end();

    const events = await collect(mapEventsToCanonical(source));
    const deltas = events.filter((event) => event.type === "toolcall_delta");
    const end = events.find((event) => event.type === "toolcall_end");
    expect(deltas.map((event) => event.delta).join("")).toBe(
      JSON.stringify({ code, description: RUN_CODE_DESCRIPTION }),
    );
    expect(end).toMatchObject({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        id: "call-1|ctc-1",
        name: RUN_CODE_NAME,
        arguments: { code, description: RUN_CODE_DESCRIPTION },
      },
    });
    expect(events[0]).toMatchObject({
      type: "toolcall_start",
      partial: {
        content: [
          { arguments: { code: "", description: RUN_CODE_DESCRIPTION } },
        ],
      },
    });
  });

  it("normalizes fragmented streamed patch input and patch history", async () => {
    const patch =
      "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch";
    const canonicalToolCall = {
      type: "toolCall" as const,
      id: "call-patch|fc-patch",
      name: APPLY_PATCH_NAME,
      arguments: { patch },
    };
    const context: PiContext = {
      messages: [assistant([canonicalToolCall])],
      tools: [runCodeTool(), applyPatchTool()],
    };
    const before = structuredClone(context);
    const mapped = mapContextToCodex(context);
    const mappedMessage = mapped.messages[0];
    expect(mappedMessage).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: APPLY_PATCH_NAME,
          arguments: { input: patch },
        },
      ],
    });
    expect(mapped).not.toBe(context);
    expect(context).toEqual(before);

    const source = createAssistantMessageEventStream();
    const initial = assistant([
      {
        type: "toolCall",
        id: "call-patch|ctc-patch",
        name: APPLY_PATCH_NAME,
        arguments: { input: "" },
      },
    ]);
    source.push({ type: "toolcall_start", contentIndex: 0, partial: initial });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "ignored",
      partial: assistant([
        {
          type: "toolCall",
          id: "call-patch|ctc-patch",
          name: APPLY_PATCH_NAME,
          arguments: { input: patch.slice(0, 25) },
        },
      ]),
    });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "ignored",
      partial: assistant([
        {
          type: "toolCall",
          id: "call-patch|ctc-patch",
          name: APPLY_PATCH_NAME,
          arguments: { input: patch },
        },
      ]),
    });
    const complete = assistant([
      {
        type: "toolCall",
        id: "call-patch|ctc-patch",
        name: APPLY_PATCH_NAME,
        arguments: { input: patch },
      },
    ]);
    source.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: complete.content[0] as Extract<
        AssistantMessage["content"][number],
        { type: "toolCall" }
      >,
      partial: complete,
    });
    source.end();

    const events = await collect(mapEventsToCanonical(source));
    const deltas = events.filter((event) => event.type === "toolcall_delta");
    expect(deltas.map((event) => event.delta).join("")).toBe(
      JSON.stringify({ patch }),
    );
    expect(events.find((event) => event.type === "toolcall_end")).toMatchObject(
      {
        type: "toolcall_end",
        toolCall: {
          name: APPLY_PATCH_NAME,
          arguments: { patch },
        },
      },
    );
    expect(events[0]).toMatchObject({
      type: "toolcall_start",
      partial: { content: [{ arguments: { patch: "" } }] },
    });
  });

  it.each(["", "return await tools.partial();\n"])(
    "preserves upstream metadata for an aborted partial custom call (%j)",
    async (input) => {
      const source = createAssistantMessageEventStream();
      const failed: AssistantMessage = {
        ...assistant([
          {
            type: "toolCall",
            id: "call-error|ctc-error",
            name: RUN_CODE_NAME,
            arguments: { input },
          },
        ]),
        model: "gpt-5-codex-upstream",
        responseModel: "gpt-5-codex-response",
        responseId: "resp-error",
        diagnostics: [
          {
            type: "upstream-abort",
            timestamp: 7,
            details: { request: "req-error" },
          },
        ],
        usage: {
          input: 11,
          output: 13,
          cacheRead: 17,
          cacheWrite: 19,
          totalTokens: 60,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            total: 10,
          },
        },
        stopReason: "aborted",
        rawStopReason: "cancelled_by_client",
        errorMessage: "upstream request aborted",
      };
      source.push({ type: "error", reason: "aborted", error: failed });
      source.end();

      const events = await collect(mapEventsToCanonical(source));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        reason: "aborted",
        error: {
          model: "gpt-5-codex-upstream",
          responseModel: "gpt-5-codex-response",
          responseId: "resp-error",
          diagnostics: failed.diagnostics,
          usage: failed.usage,
          stopReason: "aborted",
          rawStopReason: "cancelled_by_client",
          errorMessage: "upstream request aborted",
          content: [
            {
              arguments: { code: input, description: RUN_CODE_DESCRIPTION },
            },
          ],
        },
      });
    },
  );

  it("scopes cached transport resources and active requests to one plugin lifecycle", () => {
    const cleanup = vi.fn<(key: string | undefined) => void>();
    const unregisterCleanup = registerSessionResourceCleanup(cleanup);
    const lifecycle = createCodexProviderLifecycle();
    try {
      const first = lifecycle.beginRequest("https://codex-a.test", {
        sessionId: "session-1",
      });
      const reused = lifecycle.beginRequest("https://codex-a.test", {
        sessionId: "session-1",
      });
      const changedEndpoint = lifecycle.beginRequest("https://codex-b.test", {
        sessionId: "session-1",
      });
      expect(first.options.sessionId).toBe(reused.options.sessionId);
      expect(first.options.sessionId).not.toBe(
        changedEndpoint.options.sessionId,
      );
      expect(first.options.sessionId).not.toBe("session-1");
      expect(first.options.signal).toBeDefined();
      expect(reused.options.signal).toBeDefined();
      expect(changedEndpoint.options.signal).toBeDefined();

      lifecycle.disposeSession("session-1");
      expect(first.options.signal?.aborted).toBe(true);
      expect(reused.options.signal?.aborted).toBe(true);
      expect(changedEndpoint.options.signal?.aborted).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(new Set(cleanup.mock.calls.map(([key]) => key))).toHaveLength(2);

      const otherLifecycle = createCodexProviderLifecycle();
      try {
        const other = otherLifecycle.beginRequest("https://codex-a.test", {
          sessionId: "session-1",
        });
        expect(other.options.sessionId).not.toBe(first.options.sessionId);
        otherLifecycle.dispose();
      } finally {
        otherLifecycle.dispose();
      }
      expect(cleanup).toHaveBeenCalledTimes(3);
    } finally {
      lifecycle.dispose();
      unregisterCleanup();
    }
  });

  it("keeps the public profile on the Codex Responses API and normal DSH retry defaults", () => {
    const profile = createCodexProfile(settings);
    expect(profile).toMatchObject({
      provider: "codex-code-mode",
      api: "openai-codex-responses",
      baseURL: settings.baseURL,
      transport: settings.transport,
      retryPolicy: { mode: "normal", maxRetries: 5 },
      piProvider: { id: "codex-code-mode" },
    });
    expect(profile.configuredMaxTokens.get("gpt-5-codex")).toBe(32_768);
    expect(profile.piProvider.getModels()[0]).toMatchObject({
      id: "gpt-5-codex",
      api: "openai-codex-responses",
      compat: { supportsOpenAIGrammarTools: true },
    });
  });
});
