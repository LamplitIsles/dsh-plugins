import { createHash } from "node:crypto";
import type {
  AuthContext,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context as PiContext,
  Model,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  Tool as PiTool,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  cleanupSessionResources,
  createAssistantMessageEventStream,
  createProvider,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type {
  PiAiAdapterOptions,
  ResolvedPiAiProviderProfile,
} from "@deepseek-ai/dsh-llm-pi-ai";
import {
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  CODE_MODE_TOOL_DESCRIPTION,
  CODE_MODE_GRAMMAR,
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
  APPLY_PATCH_NAME,
  PROVIDER_ID,
  RUN_CODE_DESCRIPTION,
  RUN_CODE_NAME,
  type CodexSettings,
} from "./constants.js";
import { normalizeCodexModel } from "./settings.js";

const CODEX_API = "openai-codex-responses" as const;
const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(
  undefined,
  "dsh-codex-code-mode: retryPolicy",
);

let lifecycleSequence = 0;

type CodexRequestOptions = {
  signal?: AbortSignal;
  sessionId?: string;
};

type CodexRequestLease = {
  options: CodexRequestOptions;
  finish(): void;
};

export interface CodexProviderLifecycle {
  beginRequest(
    endpoint: string,
    options?: CodexRequestOptions,
  ): CodexRequestLease;
  disposeSession(sessionId: string): void;
  dispose(): void;
}

/** Own Codex transport keys and in-flight streams for one Host plugin instance. */
export function createCodexProviderLifecycle(): CodexProviderLifecycle {
  const instanceId = `codex-code-mode-${++lifecycleSequence}`;
  const lifetime = new AbortController();
  const ownedSessionIds = new Set<string>();
  const sessionKeys = new Map<string, Set<string>>();
  const activeRequests = new Map<AbortController, string | undefined>();
  let disposed = false;

  const transportSessionId = (endpoint: string, sessionId: string): string => {
    const key = createHash("sha256")
      .update(instanceId)
      .update("\0")
      .update(endpoint)
      .update("\0")
      .update(sessionId)
      .digest("hex");
    ownedSessionIds.add(key);
    let keys = sessionKeys.get(sessionId);
    if (keys === undefined) {
      keys = new Set();
      sessionKeys.set(sessionId, keys);
    }
    keys.add(key);
    return key;
  };

  const cleanup = (key: string): void => {
    try {
      cleanupSessionResources(key);
    } catch {
      // A Host teardown must continue cleaning the other keys this instance owns.
    }
    ownedSessionIds.delete(key);
  };

  return {
    beginRequest(endpoint, options) {
      const request = new AbortController();
      const originalSessionId =
        options?.sessionId === undefined || options.sessionId.length === 0
          ? undefined
          : options.sessionId;
      const sessionId =
        originalSessionId === undefined
          ? undefined
          : transportSessionId(endpoint, originalSessionId);
      activeRequests.set(request, originalSessionId);
      const signals = [lifetime.signal, request.signal, options?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const signal =
        signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      let finished = false;
      return {
        options: {
          ...options,
          ...(sessionId === undefined ? {} : { sessionId }),
          signal,
        },
        finish() {
          if (finished) return;
          finished = true;
          activeRequests.delete(request);
        },
      };
    },
    disposeSession(sessionId) {
      for (const [request, requestSessionId] of activeRequests) {
        if (requestSessionId === sessionId) request.abort("session disposed");
      }
      for (const key of sessionKeys.get(sessionId) ?? []) cleanup(key);
      sessionKeys.delete(sessionId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort("Codex code-mode plugin disposed");
      for (const request of activeRequests.keys())
        request.abort("Codex code-mode plugin disposed");
      activeRequests.clear();
      for (const key of ownedSessionIds) cleanup(key);
      sessionKeys.clear();
    },
  };
}

type CanonicalRunCodeArguments = {
  code: string;
  description: typeof RUN_CODE_DESCRIPTION;
};

type DirectToolName = typeof RUN_CODE_NAME | typeof APPLY_PATCH_NAME;

function isDirectToolName(name: string): name is DirectToolName {
  return name === RUN_CODE_NAME || name === APPLY_PATCH_NAME;
}

function directToolOrder(tool: PiTool): number {
  return tool.name === RUN_CODE_NAME ? 0 : 1;
}

function isRunCodeTool(tool: PiTool): boolean {
  return tool.name === RUN_CODE_NAME;
}

function isApplyPatchTool(tool: PiTool): boolean {
  return tool.name === APPLY_PATCH_NAME;
}

function requireRunCodeTool(context: PiContext): void {
  if (context.tools?.some(isRunCodeTool) !== true) {
    throw new Error(
      "Codex code-mode requires the existing DSH PTC run_code tool",
    );
  }
}

function requireApplyPatchTool(context: PiContext): void {
  if (context.tools?.some(isApplyPatchTool) !== true) {
    throw new Error(
      "Codex code-mode requires the direct apply_patch tool registration",
    );
  }
}

function canonicalArguments(
  arguments_: Record<string, unknown>,
): CanonicalRunCodeArguments {
  const code = arguments_.input;
  if (typeof code !== "string" || code.length === 0) {
    throw new Error(
      "Codex run_code custom-tool input must be a non-empty string",
    );
  }
  return { code, description: RUN_CODE_DESCRIPTION };
}

function wireArguments(
  arguments_: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof arguments_.code !== "string") {
    throw new Error(
      "Codex run_code history must contain a string code argument",
    );
  }
  return { input: arguments_.code };
}

function canonicalPatchArguments(arguments_: Record<string, unknown>): {
  patch: string;
} {
  const patch = arguments_.input;
  if (typeof patch !== "string" || patch.length === 0) {
    throw new Error(
      "Codex apply_patch custom-tool input must be a non-empty string",
    );
  }
  return { patch };
}

function wirePatchArguments(
  arguments_: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof arguments_.patch !== "string") {
    throw new Error(
      "Codex apply_patch history must contain a string patch argument",
    );
  }
  return { input: arguments_.patch };
}

function mapToolCallToWire(toolCall: ToolCall): ToolCall {
  if (toolCall.name === APPLY_PATCH_NAME)
    return { ...toolCall, arguments: wirePatchArguments(toolCall.arguments) };
  if (toolCall.name !== RUN_CODE_NAME)
    return { ...toolCall, arguments: { ...toolCall.arguments } };
  return { ...toolCall, arguments: wireArguments(toolCall.arguments) };
}

function mapMessageToWire(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "toolCall" ? mapToolCallToWire(block) : { ...block },
    ),
  };
}

function mapHistoryToWire(context: PiContext): PiContext {
  const mapped: PiContext = {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "assistant") {
        if (message.role === "toolResult") {
          return {
            ...message,
            content: message.content.map((block) => ({ ...block })),
          };
        }
        return {
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((block) => ({ ...block }))
            : message.content,
        };
      }
      return mapMessageToWire(message);
    }),
    ...(context.tools === undefined
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            ...tool,
            parameters: structuredClone(tool.parameters),
          })),
        }),
  };
  return mapped;
}

function mapToolToCodex(tool: PiTool): PiTool {
  if (isApplyPatchTool(tool)) {
    return {
      name: APPLY_PATCH_NAME,
      description: APPLY_PATCH_DESCRIPTION,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          input: {
            type: "string",
            description: "The complete raw Codex Add File/Update File patch.",
          },
        },
        required: ["input"],
      },
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: APPLY_PATCH_GRAMMAR },
      },
    };
  }
  if (!isRunCodeTool(tool)) {
    return { ...tool, parameters: structuredClone(tool.parameters) };
  }
  return {
    name: RUN_CODE_NAME,
    description: CODE_MODE_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        input: {
          type: "string",
          description:
            "The complete raw TypeScript program to run through DSH PTC.",
        },
      },
      required: ["input"],
    },
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: CODE_MODE_GRAMMAR },
    },
  };
}

export function mapContextToCodex(context: PiContext): PiContext {
  requireRunCodeTool(context);
  requireApplyPatchTool(context);
  const mapped = mapHistoryToWire(context);
  return mapped.tools === undefined
    ? mapped
    : {
        ...mapped,
        tools: mapped.tools
          .filter((tool) => isDirectToolName(tool.name))
          .sort((left, right) => directToolOrder(left) - directToolOrder(right))
          .map(mapToolToCodex),
      };
}

function canonicalJsonPrefix(
  input: string,
  previousInput: string,
  started: boolean,
  field: "code" | "patch",
): string {
  if (!input.startsWith(previousInput)) {
    throw new Error(
      `Codex ${field === "patch" ? APPLY_PATCH_NAME : RUN_CODE_NAME} custom-tool input changed non-monotonically`,
    );
  }
  const suffix = input.slice(previousInput.length);
  const escaped = JSON.stringify(suffix).slice(1, -1);
  return `${started ? "" : `{"${field}":"`}${escaped}`;
}

function canonicalJsonClose(
  input: string,
  started: boolean,
  field: "code" | "patch",
): string {
  if (field === "patch") {
    if (started) return '"}';
    return `${'{"patch":"'}${JSON.stringify(input).slice(1, -1)}"}`;
  }
  const prefix = started
    ? ""
    : `${'{"code":"'}${JSON.stringify(input).slice(1, -1)}`;
  return `${prefix}${'","description":"'}${RUN_CODE_DESCRIPTION}"}`;
}

function toolCallAt(
  message: AssistantMessage,
  contentIndex: number,
): ToolCall | undefined {
  const block = message.content[contentIndex];
  return block?.type === "toolCall" ? block : undefined;
}

function mapPartial(
  partial: AssistantMessage,
  contentIndex: number,
  input: string,
  closed = false,
): AssistantMessage {
  const toolCall = toolCallAt(partial, contentIndex);
  if (!toolCall || !isDirectToolName(toolCall.name)) return partial;
  const arguments_ =
    toolCall.name === APPLY_PATCH_NAME
      ? closed
        ? canonicalPatchArguments({ input })
        : { patch: input }
      : closed
        ? canonicalArguments({ input })
        : { code: input, description: RUN_CODE_DESCRIPTION };
  return {
    ...partial,
    content: partial.content.map((block, index) =>
      index === contentIndex && block.type === "toolCall"
        ? { ...block, arguments: arguments_ }
        : { ...block },
    ),
  };
}

function mapEvent(
  event: AssistantMessageEvent,
  inputs: Map<number, { value: string; started: boolean }>,
): AssistantMessageEvent[] {
  if (event.type === "toolcall_delta") {
    const toolCall = toolCallAt(event.partial, event.contentIndex);
    if (!toolCall || !isDirectToolName(toolCall.name)) return [{ ...event }];
    const input =
      typeof toolCall.arguments.input === "string"
        ? toolCall.arguments.input
        : "";
    const previous = inputs.get(event.contentIndex) ?? {
      value: "",
      started: false,
    };
    const delta = canonicalJsonPrefix(
      input,
      previous.value,
      previous.started,
      toolCall.name === APPLY_PATCH_NAME ? "patch" : "code",
    );
    inputs.set(event.contentIndex, {
      value: input,
      started: true,
    });
    return [
      {
        ...event,
        delta,
        partial: mapPartial(event.partial, event.contentIndex, input),
      },
    ];
  }
  if (event.type === "toolcall_end") {
    if (!isDirectToolName(event.toolCall.name))
      return [{ ...event, toolCall: { ...event.toolCall } }];
    const input = event.toolCall.arguments.input;
    if (typeof input !== "string" || input.length === 0) {
      throw new Error(
        `Codex ${event.toolCall.name} custom-tool input must be a non-empty string`,
      );
    }
    const previous = inputs.get(event.contentIndex) ?? {
      value: "",
      started: false,
    };
    const field = event.toolCall.name === APPLY_PATCH_NAME ? "patch" : "code";
    const close = canonicalJsonClose(input, previous.started, field);
    inputs.set(event.contentIndex, {
      value: input,
      started: true,
    });
    const canonical =
      event.toolCall.name === APPLY_PATCH_NAME
        ? canonicalPatchArguments({ input })
        : canonicalArguments({ input });
    return [
      {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: close,
        partial: mapPartial(event.partial, event.contentIndex, input, true),
      },
      {
        ...event,
        toolCall: { ...event.toolCall, arguments: canonical },
        partial: mapPartial(event.partial, event.contentIndex, input, true),
      },
    ];
  }
  if (event.type === "toolcall_start") {
    const toolCall = toolCallAt(event.partial, event.contentIndex);
    if (toolCall !== undefined && isDirectToolName(toolCall.name)) {
      inputs.set(event.contentIndex, {
        value: "",
        started: false,
      });
      return [
        {
          ...event,
          partial: mapPartial(event.partial, event.contentIndex, ""),
        },
      ];
    }
    return [{ ...event }];
  }
  if (event.type === "done")
    return [{ ...event, message: mapMessageFromCodex(event.message) }];
  if (event.type === "error")
    return [{ ...event, error: mapMessageFromCodex(event.error, true) }];
  return [{ ...event }];
}

function partialArguments(
  arguments_: Record<string, unknown>,
  toolName: DirectToolName,
): CanonicalRunCodeArguments | { patch: string } {
  if (toolName === APPLY_PATCH_NAME) {
    return {
      patch:
        typeof arguments_.input === "string"
          ? arguments_.input
          : typeof arguments_.patch === "string"
            ? arguments_.patch
            : "",
    };
  }
  const code =
    typeof arguments_.input === "string"
      ? arguments_.input
      : typeof arguments_.code === "string"
        ? arguments_.code
        : "";
  return { code, description: RUN_CODE_DESCRIPTION };
}

function mapMessageFromCodex(
  message: AssistantMessage,
  allowIncomplete = false,
): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "toolCall" || !isDirectToolName(block.name))
        return { ...block };
      return {
        ...block,
        arguments: allowIncomplete
          ? partialArguments(block.arguments, block.name)
          : block.name === APPLY_PATCH_NAME
            ? canonicalPatchArguments(block.arguments)
            : canonicalArguments(block.arguments),
      };
    }),
  };
}

/** Map pi-ai's mutable event stream to detached canonical DSH-facing events. */
export function mapEventsToCanonical(
  source: AssistantMessageEventStream,
  onComplete?: () => void,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    const inputs = new Map<number, { value: string; started: boolean }>();
    try {
      for await (const event of source) {
        for (const mapped of mapEvent(event, inputs)) output.push(mapped);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const assistantError: AssistantMessage = {
        role: "assistant",
        content: [],
        api: CODEX_API,
        provider: PROVIDER_ID,
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: message,
        timestamp: Date.now(),
      };
      output.push({ type: "error", reason: "error", error: assistantError });
    } finally {
      onComplete?.();
      output.end();
    }
  })();
  return output;
}

function bindStreamOptions<T extends StreamOptions | SimpleStreamOptions>(
  lifecycle: CodexProviderLifecycle,
  model: Model<typeof CODEX_API>,
  options: T | undefined,
): { options: T; finish(): void } {
  const lease = lifecycle.beginRequest(model.baseUrl, options);
  return {
    options: lease.options as T,
    finish: () => lease.finish(),
  };
}

function codexApiStreams(lifecycle: CodexProviderLifecycle): ProviderStreams {
  const api = openAICodexResponsesApi();
  return {
    stream: (model, context, options) => {
      const mappedContext = mapContextToCodex(context);
      const codexModel = model as Model<typeof CODEX_API>;
      const request = bindStreamOptions(lifecycle, codexModel, options);
      try {
        return mapEventsToCanonical(
          api.stream(codexModel, mappedContext, request.options),
          () => request.finish(),
        );
      } catch (error) {
        request.finish();
        throw error;
      }
    },
    streamSimple: (model, context, options) => {
      const mappedContext = mapContextToCodex(context);
      const codexModel = model as Model<typeof CODEX_API>;
      const request = bindStreamOptions(lifecycle, codexModel, options);
      try {
        return mapEventsToCanonical(
          api.streamSimple(codexModel, mappedContext, request.options),
          () => request.finish(),
        );
      } catch (error) {
        request.finish();
        throw error;
      }
    },
  };
}

function createModel(
  settings: CodexSettings,
  modelSettings: CodexSettings["models"][number],
): Model<typeof CODEX_API> {
  const model = normalizeCodexModel(modelSettings);
  return {
    id: model.id,
    name: model.name,
    api: CODEX_API,
    provider: PROVIDER_ID,
    baseUrl: settings.baseURL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsDeveloperRole: true,
      supportsStrictMode: true,
    },
  };
}

function createAuth(): PiAiAdapterOptions["auth"] {
  const credentials = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error(
        "dsh-codex-code-mode does not expose pi-ai login storage",
      );
    },
    delete: async () => {
      throw new Error(
        "dsh-codex-code-mode does not expose pi-ai login storage",
      );
    },
  } satisfies PiAiAdapterOptions["auth"]["credentials"];
  const authContext: AuthContext = {
    env: async (name) => process.env[name],
    fileExists: async () => false,
  };
  return { credentials, authContext };
}

function apiKeyAuth(): NonNullable<
  Provider<typeof CODEX_API>["auth"]["apiKey"]
> {
  return {
    name: "dsh-codex-code-mode credential",
    resolve: async ({ credential }) =>
      credential?.key === undefined
        ? undefined
        : { auth: { apiKey: credential.key }, source: "dsh-codex-code-mode" },
  };
}

export function createCodexProfile(
  settings: CodexSettings,
  lifecycle = createCodexProviderLifecycle(),
): ResolvedPiAiProviderProfile {
  const models = settings.models.map((model) => createModel(settings, model));
  const piProvider = createProvider({
    id: PROVIDER_ID,
    name: "Codex code mode",
    baseUrl: settings.baseURL,
    auth: { apiKey: apiKeyAuth() },
    models,
    api: codexApiStreams(lifecycle),
  });
  return {
    provider: PROVIDER_ID,
    displayName: "Codex code mode",
    api: CODEX_API,
    baseURL: settings.baseURL,
    transport: settings.transport,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4 * 1024 * 1024,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: DEFAULT_RETRY_POLICY,
    apiKeyEnv: credentialRef(settings.credentialRef),
    piProvider,
    configuredMaxTokens: new Map(
      models.map((model) => [model.id, model.maxTokens]),
    ),
  } as ResolvedPiAiProviderProfile;
}

export function createCodexAuth(): PiAiAdapterOptions["auth"] {
  return createAuth();
}
