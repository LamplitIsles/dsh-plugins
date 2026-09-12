import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { Agent as NodeAgent, Transport, type TurnUsage } from "nanocodex/node";
import {
  isSupportedModel,
  MODEL_CONTEXT_WINDOW,
  SUPPORTED_MODELS,
  type NanocodexModel,
} from "./constants.js";
import { buildHistorySeed, buildPromptInput } from "./history.js";
import {
  resolveNanocodexRoute,
  supportedThinking,
  SETTINGS_NAMESPACE,
  type SettingsContext,
  type NanocodexProvider,
} from "./settings.js";
import { normalizeTokenUsage } from "./output.js";
import { observeTransportFallback } from "./transport-diagnostic.js";

const REASONING_EFFORTS = [
  ["none", "None"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
  ["pro", "Pro"],
] as const;

function usage(value: TurnUsage): TokenUsage | undefined {
  return normalizeTokenUsage({
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    cacheReadTokens: value.cached_input_tokens,
    cacheWriteTokens: value.cache_write_input_tokens,
    reasoningTokens: value.reasoning_output_tokens,
  });
}

function providerName(provider: string): string {
  return provider === "openai-codex-responses"
    ? "OpenAI Codex Responses"
    : "OpenAI Responses";
}

function modelName(model: string): string {
  return model
    .replaceAll("-", " ")
    .replace(/(^| )([a-z])/gu, (_, p, c) => `${p}${c.toUpperCase()}`);
}

function isProvider(value: string): value is NanocodexProvider {
  return value === "openai" || value === "openai-codex-responses";
}

function defaultReasoning(ctx: Context, provider: string): string | undefined {
  const settings = (ctx as Context & SettingsContext).settings.get(
    SETTINGS_NAMESPACE,
  );
  if (!settings || typeof settings !== "object") return undefined;
  const providers = (settings as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return undefined;
  const profile = (providers as Record<string, unknown>)[provider];
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    return undefined;
  return supportedThinking(
    (profile as { reasoning?: unknown }).reasoning as string | undefined,
  );
}

/** Native DSH model-catalog adapter for the Nanocodex-owned routes. */
export class NanocodexLlmAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context) {
    super();
  }

  override providerInfo(provider: string) {
    if (!isProvider(provider))
      throw new Error(
        `Nanocodex does not own provider ${JSON.stringify(provider)}`,
      );
    return { id: provider, name: providerName(provider) };
  }

  override async listModels(
    provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider);
    return SUPPORTED_MODELS.map((id) => ({
      provider,
      id,
      name: modelName(id),
      inputModalities: ["text", "image"] as const,
    }));
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted();
    this.providerInfo(provider);
    if (!isSupportedModel(model))
      throw new Error(
        `Nanocodex does not support model ${JSON.stringify(model)}`,
      );
    const configured = defaultReasoning(this.ctx, provider);
    const efforts = REASONING_EFFORTS.map(([id, name]) => ({
      id: ReasoningEffortId(id),
      name,
    }));
    return {
      provider,
      id: model,
      name: modelName(model),
      inputModalities: ["text", "image"],
      context: { contextWindow: MODEL_CONTEXT_WINDOW },
      reasoning: {
        efforts,
        ...(configured === undefined
          ? {}
          : { defaultEffort: ReasoningEffortId(configured) }),
      },
    };
  }

  /**
   * The retained session-title consumer uses this one-shot path. Ordinary
   * conversation turns remain owned by NanocodexAgent/NanocodexEngine and do
   * not recurse through DSH's LLM runtime.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamOneShot(options);
  }

  private async *streamOneShot(
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (!isSupportedModel(options.model))
      throw new Error(
        `Nanocodex does not support model ${JSON.stringify(options.model)}`,
      );
    const route = await resolveNanocodexRoute(
      this.ctx as Context & SettingsContext,
      {
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      },
    );
    const last = options.messages.at(-1);
    const seedMessages =
      last?.role === "user" ? options.messages.slice(0, -1) : options.messages;
    const historySeed = await buildHistorySeed(seedMessages, this.ctx, signal);
    const input =
      last?.role === "user"
        ? await buildPromptInput([last], this.ctx, signal)
        : "Continue from the current conversation.";
    // Nanocodex reserves one active local Agent per session ID. Ancillary DSH
    // calls can run while the conversation's real Agent is live, so they need
    // an ephemeral engine identity even when their history is scoped to a DSH
    // session. The DSH session ID remains the diagnostic correlation and the
    // complete request history is still seeded explicitly above.
    const runtimeSessionId = randomUUID();
    const nodeAgent = await NodeAgent.create({
      transport: Transport.openAi({
        apiKey: route.apiKey,
        ...(route.apiBaseUrl ? { apiBaseUrl: route.apiBaseUrl } : {}),
        ...(route.websocketUrl ? { websocketUrl: route.websocketUrl } : {}),
        // A one-shot ancillary call does not need a separate warmup request;
        // the live conversation runtime owns that connection policy.
        websocketWarmup: false,
      }),
      model: options.model as NanocodexModel,
      ...(route.thinking ? { thinking: route.thinking } : {}),
      ...(options.reasoningEffort === "pro"
        ? { reasoningMode: "pro" as const }
        : {}),
      sessionId: runtimeSessionId,
      subagents: false,
      historySeed,
      instructions: options.system ?? "",
    });
    const removeTransportFallback = observeTransportFallback(
      this.ctx,
      options.sessionId === undefined
        ? nodeAgent.sessionId
        : String(options.sessionId),
      nodeAgent,
    );
    const turn = nodeAgent.turn.prompt({ input });
    const abort = () => void turn.cancel().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await turn.accepted();
      const result = await turn.result();
      try {
        signal?.throwIfAborted();
        if (result.finalMessage) {
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: result.finalMessage };
          yield {
            type: "block-end",
            index: 0,
            block: { type: "text", text: result.finalMessage },
          };
        }
        const turnUsage = await result.usage();
        const normalizedUsage = usage(turnUsage);
        if (normalizedUsage !== undefined)
          yield { type: "usage", usage: normalizedUsage };
        yield { type: "finish", reason: { kind: "stop" } };
      } finally {
        result.dispose();
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      removeTransportFallback();
      turn.dispose();
      nodeAgent.dispose();
    }
  }
}
