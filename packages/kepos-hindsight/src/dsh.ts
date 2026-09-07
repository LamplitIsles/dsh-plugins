import { randomUUID } from "node:crypto";

import z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-system-prompt";

import { HindsightClient } from "./api.js";
import { resolveCompanionConfig } from "./config.js";
import { composeRecallQuery, renderMemoryContext } from "./context.js";
import {
  DEFAULT_COMPANION_SETTINGS,
  normalizeCompanionSettings,
  SETTINGS_NAMESPACE
} from "./settings.js";
import { recentUserText, textOf, transcriptForTurn, transcriptThroughTurn } from "./transcript.js";
import type { CompanionSettings } from "./settings.js";
import type { DshPluginConfig, ResolvedCompanionConfig } from "./types.js";

export const name = "kepos-hindsight";
export const inject = ["agents", "settings", "systemPrompt", "tools"] as const;

export const REFLECT_PROMPT_TEXT =
  "Relevant raw memories are already supplied each turn. Reserve hindsight_reflect for shared-history synthesis: a user-invited look back, or an answer that must reconcile multiple episodes about change, recurring dynamics, milestones, promises, boundaries, unfinished threads, or rupture and repair. "
  + "Answer single facts, preferences, present-moment support, and ordinary personalization directly from the conversation and supplied memories. "
  + "When Reflect fits, ask one focused question with the subject, perspective, and time frame. Treat its result as fallible evidence: preserve attribution and uncertainty, distinguish memory from inference and past from present, and answer in your own companion voice. Ground interpretations in remembered events. Offer psychological interpretations only when the user asks for them; never present a diagnosis or hidden motive as fact.";

export const CompanionSettingsSchema = z.object({
  bankId: z.string().min(1).default(DEFAULT_COMPANION_SETTINGS.bankId)
});

type AgentLike = {
  session: {
    header: {
      id: string;
      origin?: string;
    };
    snapshotEvents: () => readonly unknown[];
  };
};

type PreStepDecision = { kind: string; messages?: unknown[] };
type ModelSurfaceContext = {
  systemPrompt: {
    section: (section: { name: string; order: number; text: string }) => void;
  };
  tools: { register: (tool: unknown) => void };
};
type ToolExecution = { signal: AbortSignal };
type RuntimeResolver = () => ResolvedCompanionConfig;
type HostContext = {
  settings: {
    register: (namespace: string, schema: unknown, options?: unknown) => { get: () => unknown };
  };
  on: (event: string, listener: unknown, options?: unknown) => void;
  inject: (services: string[], callback: (context: ModelSurfaceContext) => void) => void;
};

const retainedTurns = new Map<string, Set<number>>();
const retainedSessionTargets = new Map<string, string>();
const retainSubmissionQueues = new Map<string, Promise<void>>();
const REFLECT_TOOL_TIMEOUT_MS = 330_000;

function clientFor(config: ResolvedCompanionConfig): HindsightClient {
  return new HindsightClient(config.apiUrl, config.bankId, config.apiToken);
}

function retainTarget(config: ResolvedCompanionConfig): string {
  return `${config.apiUrl}\n${config.bankId}`;
}

function enqueueRetain(sessionId: string, task: () => Promise<void>): Promise<void> {
  const previous = retainSubmissionQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(task);
  retainSubmissionQueues.set(sessionId, queued);
  void queued.then(
    () => {
      if (retainSubmissionQueues.get(sessionId) === queued) retainSubmissionQueues.delete(sessionId);
    },
    () => {
      if (retainSubmissionQueues.get(sessionId) === queued) retainSubmissionQueues.delete(sessionId);
    }
  );
  return queued;
}

function isCompanionSession(agent: AgentLike): boolean {
  return agent.session.header.origin !== "subagent";
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function directUserPrompt(messages: unknown[] | undefined): string {
  return (messages ?? [])
    .filter((message) => isDirectUserMessage(message))
    .map(textOf)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isDirectUserMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null
    && "source" in message
    && typeof (message as { source?: unknown }).source === "object"
    && (message as { source: { kind?: unknown } }).source.kind === "user";
}

function injection(text: string): unknown {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: name, form: "recall" }
  };
}

/**
 * Every path resolves exactly one explicit companion configuration. The agent
 * event provides only session/turn/transcript data, never bank selection.
 */
export function createDshHooks(
  pluginConfig: DshPluginConfig = {},
  getSettings: () => CompanionSettings = () => DEFAULT_COMPANION_SETTINGS
) {
  const runtime: RuntimeResolver = () => resolveCompanionConfig(
    pluginConfig,
    normalizeCompanionSettings(getSettings())
  );
  return {
    async preStep(payload: { agent: AgentLike; turn: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> {
      const decision = await next();
      if (decision.kind !== "enter" || payload.signal.aborted || !isCompanionSession(payload.agent)) return decision;
      const prompt = directUserPrompt(decision.messages);
      if (!prompt) return decision;
      const config = runtime();
      if (!config.enabled) return decision;
      try {
        const history = recentUserText(payload.agent.session.snapshotEvents() as readonly never[], config.recall.contextTurns);
        // DSH normally records the direct message after pre-step, but resumed
        // or test adapters can already expose it. Avoid querying that message twice.
        const prior = history.at(-1) === prompt ? history.slice(0, -1) : history;
        const previous = prior.slice(-Math.max(0, config.recall.contextTurns - 1));
        const query = composeRecallQuery(previous, prompt, config.recall.maxQueryChars);
        const memories = await clientFor(config).recall(query, config.recall, timeoutSignal(payload.signal, config.recall.timeoutMs));
        const context = renderMemoryContext(memories);
        return { ...decision, messages: [...(decision.messages ?? []), injection(context)] };
      } catch {
        // Retrieval is supplementary; a slow or unavailable memory service never blocks conversation.
        return { ...decision, messages: [...(decision.messages ?? []), injection(renderMemoryContext([]))] };
      }
    },

    async turnStopping(payload: { agent: AgentLike; turn: number }): Promise<void> {
      if (!isCompanionSession(payload.agent)) return;
      const config = runtime();
      if (!config.enabled || !config.retainSessions) return;
      const sessionId = payload.agent.session.header.id;
      const turns = retainedTurns.get(sessionId) ?? new Set<number>();
      retainedTurns.set(sessionId, turns);
      if (turns.has(payload.turn)) return;
      turns.add(payload.turn);
      await enqueueRetain(sessionId, async () => {
        const target = retainTarget(config);
        const updateMode = retainedSessionTargets.get(sessionId) === target ? "append" : "replace";
        const transcript = updateMode === "replace"
          ? transcriptThroughTurn(payload.agent.session.snapshotEvents() as readonly never[], payload.turn)
          : transcriptForTurn(payload.agent.session.snapshotEvents() as readonly never[], payload.turn);
        try {
          // The Hindsight operation remains asynchronous. Await only the small
          // HTTP acknowledgement so DSH does not finish this turn before the
          // retain request has reached the server.
          await clientFor(config).retain(sessionId, payload.turn, transcript, updateMode);
          retainedSessionTargets.set(sessionId, target);
        } catch (error) {
          retainedTurns.get(sessionId)?.delete(payload.turn);
          retainedSessionTargets.delete(sessionId);
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[kepos-hindsight] retain submission failed for session ${sessionId}, turn ${payload.turn}: ${detail}`);
        }
      });
    },

    disposed(payload: { agent: AgentLike }): void {
      const sessionId = payload.agent.session.header.id;
      retainedTurns.delete(sessionId);
      retainedSessionTargets.delete(sessionId);
    }
  };
}

function toolParameters(): unknown {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "The memory question or topic to look up" }
    },
    required: ["query"]
  };
}

function textOutput(value: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: value }];
}

function registerModelSurface(context: ModelSurfaceContext, runtime: RuntimeResolver): void {
  context.systemPrompt.section({
    name: "tool:hindsight-reflect",
    order: 114,
    text: REFLECT_PROMPT_TEXT
  });

  context.tools.register({
    name: "hindsight_reflect",
    description: "Synthesize shared history across multiple long-term memories when the Reflect guideline applies. Read-only, LLM-backed, and slow.",
    parameters: toolParameters(),
    output: { schema: { type: "string" }, render: (_args: unknown, value: string) => textOutput(value) },
    timeoutMs: REFLECT_TOOL_TIMEOUT_MS,
    async execute(args: { query: string }, execution: ToolExecution) {
      const config = runtime();
      if (!config.enabled) return "Hindsight companion memory is disabled.";
      return (await clientFor(config).reflect(args.query, execution.signal)) || "No memory synthesis was returned.";
    }
  });
}

export function apply(ctx: HostContext, pluginConfig: DshPluginConfig = {}): void {
  const settings = ctx.settings.register(
    SETTINGS_NAMESPACE,
    CompanionSettingsSchema,
    { base: DEFAULT_COMPANION_SETTINGS, applies: "live" }
  );
  const getSettings = () => normalizeCompanionSettings(settings.get());
  const hooks = createDshHooks(pluginConfig, getSettings);
  const runtime: RuntimeResolver = () => resolveCompanionConfig(pluginConfig, getSettings());
  ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
  ctx.on("agent/turn-stopping", hooks.turnStopping);
  ctx.on("agent/disposed", hooks.disposed);
  ctx.inject(["systemPrompt", "tools"], (context) => registerModelSurface(context, runtime));
}

export default { name, inject, apply };
