import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  canonicalHeader,
  headerEquals,
  SessionSeq,
  type SessionId,
  type RequestContext,
  type Session,
} from "@deepseek-ai/dsh-session";
import {
  defineDomain,
  domainTable,
  type KvTable,
} from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import {
  createToolResultMessage,
  ToolCallId,
  createUserMessage,
  type GenerateOptions,
  type Message,
  type ToolSchema,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  renderPrompt,
  type PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import {
  Agent as NodeAgent,
  createQuickJsEvaluator,
  Transport,
  type AgentEvent,
  type CodeEvaluator,
  type CompactionContext,
  type CompactionDecision,
  type CompactionInstructionContext,
  type CompactionItemIdentity,
  type CompactionOutcome,
  type CompactionReplacedEventPayload,
  type ToolDefinition as NanocodexToolDefinition,
  type SessionSnapshot,
} from "nanocodex/node";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
  APPLY_PATCH_NAME,
  isSupportedModel,
  MODEL_CONTEXT_WINDOW,
  type NanocodexModel,
} from "./constants.js";
import { buildHistorySeed, buildPromptInput, plainText } from "./history.js";
import {
  buildNanocodexCompactionPlan,
  compactionPlaceholderMessage,
  type NanocodexCompactionPlan,
  type NanocodexCompactionSurfaceSegment,
} from "./compaction-policy.js";
import { normalizeNanocodexSessionId } from "./session-id.js";
import {
  resolveNanocodexRoute,
  type ResolvedNanocodexRoute,
  type SettingsContext,
} from "./settings.js";
import { createToolBridge, type ToolBridge } from "./tool-bridge.js";
import { NanocodexOutput } from "./output.js";
import { observeTransportFallback } from "./transport-diagnostic.js";

interface ActiveTurn {
  readonly output: NanocodexOutput;
  readonly drain: () => Promise<void>;
}

export interface NanocodexCompactionResult {
  readonly summary: string;
  readonly outcome: CompactionOutcome;
  readonly selection: NanocodexCompactionSelection;
  /** The engine-owned checkpoint captured immediately after installation. */
  readonly snapshot: SessionSnapshot;
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly context: NanocodexContextAccounting;
}

export interface NanocodexContextAccounting {
  readonly contextWindowTokens: number;
  readonly activeContextTokens: number;
}

export interface NanocodexAutomaticCompaction {
  readonly outcome: CompactionOutcome;
  readonly phase: CompactionReplacedEventPayload["phase"];
  readonly afterModelCallIndex: number;
  /** Nanocodex's public phase/call boundary for the accepted replacement. */
}

type NanocodexCompactionMappingBoundary = Pick<
  NanocodexAutomaticCompaction,
  "phase" | "afterModelCallIndex"
>;

export interface NanocodexCompactionSelection {
  readonly shadowedRange: {
    readonly start: SessionSeq;
    readonly end: SessionSeq;
  };
  readonly shadowedSeqs: readonly SessionSeq[];
  /** Every contiguous DSH surface operation needed to install the policy. */
  readonly segments: readonly NanocodexCompactionSurfaceSegment[];
  readonly context: NanocodexContextAccounting;
}

export interface EngineRunResult {
  readonly provider: string;
  readonly model: NanocodexModel;
  /** The exact public Nanocodex snapshot at the successful DSH boundary. */
  readonly snapshot: SessionSnapshot;
  /** Current engine capacity and active model-context usage at this boundary. */
  readonly context: NanocodexContextAccounting;
  /**
   * Nanocodex may compact its private model context during a normal turn. The
   * adapter projects the validated private checkpoint into DSH only after the
   * turn has completed successfully.
   */
  readonly automaticCompactions: readonly NanocodexAutomaticCompaction[];
}

interface SurfaceBoundary {
  readonly replaceGeneration: number;
  readonly surfaceSeqs: readonly SessionSeq[];
  readonly messageCount: number;
  readonly fingerprint: string;
}

export interface NanocodexCheckpoint {
  readonly version: 1;
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly boundary: SurfaceBoundary;
  readonly snapshot: SessionSnapshot;
}

export type NanocodexCheckpointStore = Pick<
  KvTable<SessionId, NanocodexCheckpoint>,
  "get" | "put"
>;

export const nanocodexCheckpointDomain = defineDomain({
  name: "nanocodex_checkpoints",
  version: 1,
  layout: "per-record",
  tables: {
    sessions: domainTable<SessionId, NanocodexCheckpoint>(
      z.custom<NanocodexCheckpoint>((value) => checkpoint(value) !== undefined),
    ),
  },
});

type NodeAgentHandle = Awaited<ReturnType<typeof NodeAgent.create>>;

interface LiveRuntime {
  readonly agent: Agent;
  readonly nodeAgent: NodeAgentHandle;
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly routeKey: string;
  readonly system: string;
  readonly toolKey: string;
  readonly bridge: ToolBridge;
  active?: ActiveTurn | undefined;
  boundary?: SurfaceBoundary;
  readonly consumedCompactionRevisions: Set<string>;
  readonly pendingCompactionPlans: NanocodexCompactionPlan[];
  context?: NanocodexContextAccounting;
}

const RAW_APPLICATION_DEFINITIONS: ReadonlyMap<
  string,
  NanocodexToolDefinition
> = new Map([
  [
    APPLY_PATCH_NAME,
    {
      type: "custom",
      description: APPLY_PATCH_DESCRIPTION,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: APPLY_PATCH_GRAMMAR,
      },
    },
  ],
]);

// Compaction and controller seams carry the stable DSH Session even when the
// Agent handle itself is replaced or wrapped during Host routing.
function runtimeKey(agent: Agent): string {
  return String(agent.session.id);
}

function messageText(message: UserMessage): string {
  return plainText([message]);
}

function supplementaryContext(
  messages: readonly UserMessage[],
): string | undefined {
  const context = messages
    .filter((message) => message.source.kind === "plugin")
    .map(messageText)
    .filter(Boolean)
    .join("\n\n");
  return context || undefined;
}

function routeKey(route: ResolvedNanocodexRoute, agent: Agent): string {
  // This value is process-local only. In particular, the credential is never
  // included in a DSH event or a diagnostic message; its digest makes a
  // credential rotation force a new provider transport for the retained host.
  return JSON.stringify({
    provider: route.provider,
    model: route.model,
    apiKeyDigest: createHash("sha256").update(route.apiKey).digest("hex"),
    apiBaseUrl: route.apiBaseUrl,
    websocketUrl: route.websocketUrl,
    thinking: route.thinking,
    reasoningEffort: agent.options.reasoningEffort,
  });
}

function fingerprint(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function makeBoundary(
  session: Session,
  messages: readonly Message[],
): SurfaceBoundary {
  return {
    replaceGeneration: session.surface.replaceGeneration,
    surfaceSeqs: [...session.surface.nodes],
    messageCount: messages.length,
    fingerprint: fingerprint(messages),
  };
}

function boundaryMatches(
  boundary: SurfaceBoundary,
  session: Session,
  messages: readonly Message[],
): boolean {
  const nodes = session.surface.nodes;
  return (
    boundary.replaceGeneration === session.surface.replaceGeneration &&
    boundary.messageCount === messages.length &&
    boundary.surfaceSeqs.length <= nodes.length &&
    boundary.surfaceSeqs.every((seq, index) => nodes[index] === seq) &&
    boundary.fingerprint === fingerprint(messages)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function supportedModel(value: unknown): NanocodexModel | undefined {
  return typeof value === "string" && isSupportedModel(value)
    ? value
    : undefined;
}

function sessionSnapshot(value: unknown): SessionSnapshot | undefined {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.history)) return undefined;
  if (supportedModel(candidate.model) === undefined) return undefined;
  return candidate as unknown as SessionSnapshot;
}

function checkpoint(value: unknown): NanocodexCheckpoint | undefined {
  const candidate = record(value);
  const boundary = record(candidate?.boundary);
  const snapshot = sessionSnapshot(candidate?.snapshot);
  if (
    candidate?.version !== 1 ||
    typeof candidate.provider !== "string" ||
    supportedModel(candidate.model) === undefined ||
    !boundary ||
    snapshot === undefined ||
    snapshot.model !== candidate.model ||
    !Array.isArray(boundary.surfaceSeqs) ||
    !boundary.surfaceSeqs.every(
      (seq): seq is SessionSeq =>
        typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0,
    ) ||
    typeof boundary.replaceGeneration !== "number" ||
    !Number.isSafeInteger(boundary.replaceGeneration) ||
    boundary.replaceGeneration < 0 ||
    typeof boundary.messageCount !== "number" ||
    !Number.isSafeInteger(boundary.messageCount) ||
    boundary.messageCount < 0 ||
    typeof boundary.fingerprint !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    provider: candidate.provider,
    model: supportedModel(candidate.model)!,
    boundary: {
      replaceGeneration: boundary.replaceGeneration,
      surfaceSeqs: boundary.surfaceSeqs,
      messageCount: boundary.messageCount,
      fingerprint: boundary.fingerprint,
    },
    snapshot,
  };
}

function findMatchingCheckpoint(
  store: NanocodexCheckpointStore,
  session: Session,
  messages: readonly Message[],
  provider: string,
  model: NanocodexModel,
): NanocodexCheckpoint | undefined {
  const candidate = checkpoint(store.get(session.id));
  if (
    candidate !== undefined &&
    candidate.provider === provider &&
    candidate.model === model &&
    boundaryMatches(candidate.boundary, session, messages)
  ) {
    return candidate;
  }
  return undefined;
}

const DEFAULT_COMPACTION_INSTRUCTION = [
  "Create a concise private continuity summary of the conversation above.",
  "Preserve important facts, preferences, commitments, unresolved questions, and the immediate context.",
  "Return summary text only. Do not mention this instruction or compaction.",
].join("\n");

async function* emptyLlmStream(): AsyncGenerator<never, void, void> {}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseCompactionIdentity(
  value: unknown,
): CompactionItemIdentity | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    !integer(candidate.index) ||
    typeof candidate.kind !== "string" ||
    candidate.kind.length === 0 ||
    !nullableString(candidate.id) ||
    !nullableString(candidate.call_id)
  ) {
    return undefined;
  }
  return candidate as unknown as CompactionItemIdentity;
}

function parseCompactionInstalledItem(
  value: unknown,
): CompactionOutcome["installed_history"][number] | undefined {
  const candidate = record(value);
  if (!candidate || !record(candidate.item)) return undefined;
  const origin =
    candidate.origin === null
      ? null
      : parseCompactionIdentity(candidate.origin);
  if (origin === undefined) return undefined;
  return {
    origin,
    item: candidate.item as Record<string, unknown>,
  };
}

function parseCompactionOutcome(value: unknown): CompactionOutcome | undefined {
  const candidate = record(value);
  const context = record(candidate?.context);
  const installed = Array.isArray(candidate?.installed_history)
    ? candidate.installed_history.map(parseCompactionInstalledItem)
    : undefined;
  if (
    !candidate ||
    typeof candidate.revision !== "string" ||
    candidate.revision.length === 0 ||
    (candidate.trigger !== "manual" && candidate.trigger !== "automatic") ||
    !nullableString(candidate.summary) ||
    !installed ||
    installed.some((item): item is undefined => item === undefined) ||
    !context ||
    typeof context.workspace !== "string" ||
    !integer(context.context_window_tokens) ||
    context.context_window_tokens === 0 ||
    !integer(context.active_context_tokens) ||
    !Array.isArray(context.history) ||
    !context.history.every((item) => record(item) !== undefined)
  ) {
    return undefined;
  }
  return candidate as unknown as CompactionOutcome;
}

function parseCompactionReplacedEvent(
  event: AgentEvent,
): CompactionReplacedEventPayload | undefined {
  if (event.type !== "model.compaction.replaced") return undefined;
  const outcome = parseCompactionOutcome(event.payload);
  if (
    outcome === undefined ||
    !integer(event.payload.after_model_call_index) ||
    (event.payload.phase !== "pre_turn" && event.payload.phase !== "mid_turn")
  ) {
    return undefined;
  }
  return event.payload as unknown as CompactionReplacedEventPayload;
}

/** The only provider-facing owner in the DSH Nanocodex package. */
export class NanocodexEngine {
  private quickJsPromise: Promise<CodeEvaluator> | undefined;
  private readonly requestSurfaceGeneration = new WeakMap<Session, number>();
  private readonly runtimes = new Map<string, LiveRuntime>();

  constructor(
    private readonly ctx: Context,
    private readonly checkpoints: NanocodexCheckpointStore,
  ) {}

  private quickJs(): Promise<CodeEvaluator> {
    this.quickJsPromise ??= (async () => {
      const asyncQuickJsVariant = (
        await import("@jitl/quickjs-wasmfile-release-asyncify")
      ).default as unknown as Parameters<
        typeof newQuickJSAsyncWASMModuleFromVariant
      >[0];
      const quickJs =
        await newQuickJSAsyncWASMModuleFromVariant(asyncQuickJsVariant);
      return createQuickJsEvaluator(quickJs);
    })();
    return this.quickJsPromise;
  }

  async run(
    agent: Agent,
    previousMessages: readonly Message[],
    messages: readonly UserMessage[],
    assembly: PromptAssembly,
    turn: number,
    step: number,
    signal: AbortSignal,
    advanceStep: () => number,
  ): Promise<EngineRunResult> {
    signal.throwIfAborted();
    const route = await resolveNanocodexRoute(
      this.ctx as Context & SettingsContext,
      agent.options,
    );
    signal.throwIfAborted();
    const historySeed = await buildHistorySeed(
      previousMessages,
      this.ctx,
      signal,
    );
    // Host-injected prompt context belongs to this admitted input through
    // Nanocodex's supplementaryContext seam. It must not become a second
    // synthetic user turn or be duplicated in the ordinary prompt payload.
    const input = await buildPromptInput(
      messages.filter((message) => message.source.kind !== "plugin"),
      this.ctx,
      signal,
    );
    const system = renderPrompt(assembly);
    const quickJs = await this.quickJs();
    signal.throwIfAborted();

    const output = new NanocodexOutput(
      agent,
      route.provider,
      route.model,
      turn,
      step,
      advanceStep,
    );
    let projection = Promise.resolve();
    const active: ActiveTurn = { output, drain: () => projection };
    const visibleToolNames = new Set(assembly.tools.map((tool) => tool.name));
    const toolKey = JSON.stringify(assembly.tools);
    const key = runtimeKey(agent);
    let runtime = this.runtimes.get(key);
    if (
      runtime !== undefined &&
      (runtime.agent !== agent ||
        runtime.routeKey !== routeKey(route, agent) ||
        runtime.system !== system ||
        runtime.toolKey !== toolKey ||
        runtime.boundary === undefined ||
        !boundaryMatches(runtime.boundary, agent.session, previousMessages))
    ) {
      await this.closeRuntime(runtime);
      this.runtimes.delete(key);
      runtime = undefined;
    }
    if (runtime === undefined) {
      const bridge = createToolBridge({
        tools: this.ctx.tools,
        agent,
        signal,
        customDefinitions: RAW_APPLICATION_DEFINITIONS,
        callbacks: {
          onCall: async ({
            id,
            name,
            arguments: argumentsText,
            parentCallId,
          }) => {
            const current = runtime?.active;
            if (current === undefined)
              throw new Error("Nanocodex tool call has no active DSH step");
            await current.drain();
            if (parentCallId !== undefined) return undefined;
            return agent.session.append("tool/call", {
              ...current.output.coordinates,
              callId: ToolCallId(id),
              name,
              arguments: argumentsText,
            }).seq;
          },
          onResult: async ({ id, callSeq, result }) => {
            const current = runtime?.active;
            if (current !== undefined) await current.drain();
            if (callSeq !== undefined) {
              const call = agent.session.eventAt(callSeq);
              if (call?.type !== "tool/call")
                throw new Error("Nanocodex tool result has no durable call");
              this.appendToolResult(
                agent,
                call.data.turn,
                call.data.step,
                id,
                callSeq,
                result,
              );
            }
            for (const context of result.additionalContexts ?? []) {
              agent.inject(context);
            }
          },
        },
      }).filter((tool) => visibleToolNames.has(tool.name));
      const checkpoint = findMatchingCheckpoint(
        this.checkpoints,
        agent.session,
        previousMessages,
        route.provider,
        route.model,
      );
      const nodeAgent = await this.createNodeAgent(
        agent,
        route,
        historySeed,
        system,
        bridge,
        quickJs,
        checkpoint?.snapshot,
      );
      runtime = {
        agent,
        nodeAgent,
        provider: route.provider,
        model: route.model,
        routeKey: routeKey(route, agent),
        system,
        toolKey,
        bridge,
        consumedCompactionRevisions: new Set(),
        pendingCompactionPlans: [],
      };
      this.runtimes.set(key, runtime);
    }
    runtime.active = active;
    const automaticCompactions: NanocodexAutomaticCompaction[] = [];

    this.appendRequestFacts(
      agent,
      route.provider,
      route.model,
      agent.options.reasoningEffort,
      system,
      runtime.context,
      runtime.bridge,
    );
    const nodeAgent = runtime.nodeAgent;
    const watcher = nodeAgent.events.watch();
    const removeListener = watcher.onEvent((event) => {
      projection = projection.then(async () => {
        await output.accept(event);
        if (event.type !== "model.compaction.replaced") return;
        const replaced = parseCompactionReplacedEvent(event);
        if (replaced === undefined || replaced.trigger !== "automatic") {
          throw new Error(
            "Nanocodex emitted an invalid automatic compaction replacement",
          );
        }
        if (this.consumeCompactionOutcome(runtime, replaced)) {
          automaticCompactions.push({
            outcome: replaced,
            phase: replaced.phase,
            afterModelCallIndex: replaced.after_model_call_index,
          });
        }
      });
      // The event source cannot await listeners. Retain the error for drain()
      // and stop generation rather than accumulating an unrecordable turn.
      void projection.catch(() => modelTurn.cancel().catch(() => undefined));
    });
    const removeTransportFallback = observeTransportFallback(
      this.ctx,
      String(agent.id),
      nodeAgent,
    );
    const modelTurn = nodeAgent.turn.prompt({
      input,
      ...(supplementaryContext(messages)
        ? { supplementaryContext: supplementaryContext(messages) }
        : {}),
    });
    const abort = () => {
      void modelTurn.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    let discardRuntime = false;
    try {
      await modelTurn.accepted();
      const result = await modelTurn.result();
      try {
        await projection;
        signal.throwIfAborted();
        output.finish(result.finalMessage);
        const snapshot = await result.snapshot();
        const context = await this.readContextAccounting(nodeAgent);
        runtime.context = context;
        return {
          provider: route.provider,
          model: route.model,
          snapshot,
          context,
          automaticCompactions,
        };
      } finally {
        result.dispose();
      }
    } catch (error) {
      discardRuntime = true;
      let failure = error;
      try {
        await projection;
      } catch (projectionError) {
        // Cancellation is a consequence of an unrecordable event. Preserve
        // the original failure so the user can act on the actual cause.
        failure = projectionError;
      }
      output.interrupt(failure);
      throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      removeListener();
      watcher.off();
      removeTransportFallback();
      modelTurn.dispose();
      runtime.active = undefined;
      if (discardRuntime) {
        this.runtimes.delete(key);
        await this.closeRuntime(runtime).catch(() => undefined);
      }
    }
  }

  /** Release the retained Nanocodex host after DSH has drained the Agent. */
  async dispose(agent: Agent): Promise<void> {
    const key = runtimeKey(agent);
    const runtime = this.runtimes.get(key);
    if (runtime === undefined) return;
    this.runtimes.delete(key);
    await this.closeRuntime(runtime);
  }

  /** Invalidate a runtime whose private context no longer matches DSH. */
  async invalidate(agent: Agent): Promise<void> {
    await this.dispose(agent);
  }

  /** Mark the retained runtime at the current authoritative DSH surface. */
  markSurfaceBoundary(agent: Agent): void {
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime !== undefined) {
      runtime.boundary = makeBoundary(
        agent.session,
        agent.session.deriveMessages(),
      );
    }
  }

  private consumeCompactionOutcome(
    runtime: LiveRuntime,
    outcome: CompactionOutcome,
  ): boolean {
    if (runtime.consumedCompactionRevisions.has(outcome.revision)) return false;
    runtime.consumedCompactionRevisions.add(outcome.revision);
    return true;
  }

  private runtimeFor(agent: Agent): LiveRuntime {
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime === undefined || runtime.agent !== agent) {
      throw new Error(
        "Nanocodex compaction requires the agent's current live runtime",
      );
    }
    return runtime;
  }

  private async readContextAccounting(
    nodeAgent: NodeAgentHandle,
  ): Promise<NanocodexContextAccounting> {
    const context = await nodeAgent.session.context();
    if (
      !Number.isSafeInteger(context.context_window_tokens) ||
      context.context_window_tokens <= 0 ||
      !Number.isSafeInteger(context.active_context_tokens) ||
      context.active_context_tokens < 0
    ) {
      throw new Error("Nanocodex returned invalid context accounting");
    }
    return {
      contextWindowTokens: context.context_window_tokens,
      activeContextTokens: context.active_context_tokens,
    };
  }

  private async resolveCompaction(
    agent: Agent,
    context: CompactionContext,
    signal: AbortSignal,
  ): Promise<CompactionDecision> {
    signal.throwIfAborted();
    const plan = await buildNanocodexCompactionPlan(
      agent.session,
      context,
      this.ctx,
      signal,
    );
    signal.throwIfAborted();
    let effectivePlan = plan;
    if (!plan.segments.some((segment) => segment.kind === "remove")) {
      // DSH's successful compaction lifecycle needs one surface span to carry
      // the private checkpoint. A model-only empty node gives that lifecycle
      // an anchor when all real visible rounds are retained or only rewritten
      // (for example, a selected mixed assistant/tool message). It is skipped
      // by the history projection and is replaced by the private checkpoint
      // during the same operation.
      const anchor = agent.session.append(
        "user/message",
        compactionPlaceholderMessage(),
        { surfaceOp: "append" },
      );
      const anchorSegment: NanocodexCompactionSurfaceSegment = {
        start: anchor.seq,
        end: anchor.seq,
        shadowedSeqs: [anchor.seq],
        kind: "remove",
      };
      effectivePlan = {
        ...plan,
        segments: [...plan.segments, anchorSegment],
        shadowedSeqs: [...plan.shadowedSeqs, anchor.seq],
      };
    }
    const runtime = this.runtimeFor(agent);
    runtime.pendingCompactionPlans.push(effectivePlan);
    return effectivePlan.decision;
  }

  /**
   * Consume the host plan that produced one accepted Nanocodex replacement.
   * The plan is the immutable bridge between the callback's operation
   * snapshot and the later public event; no range is inferred from a history
   * length or from numeric sequence ordering.
   */
  async mapCompactionOutcome(
    agent: Pick<Agent, "session">,
    outcome: CompactionOutcome,
    signal: AbortSignal,
    mapping?: NanocodexCompactionMappingBoundary,
  ): Promise<NanocodexCompactionSelection> {
    signal.throwIfAborted();
    const runtime = this.runtimes.get(String(agent.session.id));
    if (runtime === undefined) {
      throw new Error(
        "Nanocodex compaction outcome has no live host selection plan",
      );
    }
    const plan = runtime.pendingCompactionPlans.shift();
    if (plan === undefined) {
      throw new Error(
        "Nanocodex compaction outcome has no pending host selection plan",
      );
    }
    if (outcome.trigger !== plan.trigger) {
      throw new Error(
        "Nanocodex compaction outcome trigger does not match its host selection",
      );
    }
    const summaryItem = plan.decision.history[0];
    if (
      summaryItem?.kind !== "summary" ||
      outcome.summary !== summaryItem.text
    ) {
      throw new Error(
        "Nanocodex compaction outcome summary does not match its host selection",
      );
    }
    if (
      mapping !== undefined &&
      (mapping.phase !== plan.phase ||
        mapping.afterModelCallIndex !== plan.afterModelCallIndex)
    ) {
      throw new Error(
        "Nanocodex compaction outcome phase does not match its host selection",
      );
    }
    if (outcome.context.context_window_tokens !== plan.contextWindowTokens) {
      throw new Error(
        "Nanocodex compaction outcome capacity changed during host selection",
      );
    }
    const expected = plan.decision.history;
    if (outcome.installed_history.length !== expected.length) {
      throw new Error(
        "Nanocodex compaction installed history does not match its host selection",
      );
    }
    for (const [index, replacement] of expected.entries()) {
      signal.throwIfAborted();
      const installed = outcome.installed_history[index];
      if (installed === undefined) {
        throw new Error("Nanocodex compaction installed history is incomplete");
      }
      if (replacement.kind === "original") {
        const origin = installed.origin;
        if (
          origin === null ||
          origin.index !== replacement.origin.index ||
          origin.kind !== replacement.origin.kind ||
          origin.id !== replacement.origin.id ||
          origin.call_id !== replacement.origin.call_id
        ) {
          throw new Error(
            "Nanocodex compaction installed provenance does not match its host selection",
          );
        }
      } else if (installed.origin !== null) {
        throw new Error(
          "Nanocodex compaction assigned original provenance to a new item",
        );
      }
    }
    if (plan.segments.length === 0) {
      throw new Error("Nanocodex compaction produced no DSH surface reduction");
    }
    const nodes = [...agent.session.surface.nodes];
    for (const segment of plan.segments) {
      signal.throwIfAborted();
      const startIndex = nodes.indexOf(segment.start);
      const endIndex = nodes.indexOf(segment.end);
      if (startIndex < 0 || endIndex < startIndex) {
        throw new Error(
          "Nanocodex compaction selection is no longer a current surface span",
        );
      }
      const current = nodes.slice(startIndex, endIndex + 1);
      if (
        current.length !== segment.shadowedSeqs.length ||
        current.some((seq, index) => seq !== segment.shadowedSeqs[index])
      ) {
        throw new Error(
          "Nanocodex compaction selection changed before DSH installation",
        );
      }
    }
    const first = plan.segments[0];
    if (first === undefined) {
      throw new Error("Nanocodex compaction selection has no surface segment");
    }
    return {
      shadowedRange: { start: first.start, end: first.end },
      shadowedSeqs: [...plan.shadowedSeqs],
      segments: plan.segments,
      context: {
        contextWindowTokens: outcome.context.context_window_tokens,
        activeContextTokens: outcome.context.active_context_tokens,
      },
    };
  }

  private async resolveCompactionInstruction(
    agent: Agent,
    route: ResolvedNanocodexRoute,
    _context: CompactionInstructionContext,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const sessionId = String(agent.session.id) as NonNullable<
      GenerateOptions["sessionId"]
    >;
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: DEFAULT_COMPACTION_INSTRUCTION }],
          source: { kind: "plugin", plugin: "dsh-compaction-basic" },
        }),
      ],
      ...(agent.options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: agent.options.reasoningEffort }),
      sessionId,
      purpose: "compaction",
      signal,
    };
    // Run the existing LLM middleware chain with an empty terminal stream.
    // Consuming the result is required because checkpoint middleware is lazy;
    // it reaches later prompt-selection listeners without dispatching a model.
    const stream = agent.ctx.waterfall(
      agent.ctx.llm,
      "llm/stream",
      options,
      emptyLlmStream,
    );
    for await (const _chunk of stream) {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const instruction = plainText(options.messages).trim();
    if (!instruction) {
      throw new Error("Nanocodex compaction instruction is empty");
    }
    return instruction;
  }

  /** Persist the exact successful engine snapshot at the current DSH surface. */
  async persistCheckpoint(
    agent: Agent,
    provider: string,
    model: NanocodexModel,
    snapshot: SessionSnapshot,
    signal: AbortSignal,
    accounting?: NanocodexContextAccounting,
  ): Promise<void> {
    signal.throwIfAborted();
    const session = agent.session;
    const boundary = makeBoundary(session, session.deriveMessages());
    const checkpoint: NanocodexCheckpoint = {
      version: 1,
      provider,
      model,
      boundary,
      snapshot,
    };
    await this.checkpoints.put(session.id, checkpoint);
    const context: RequestContext = {
      provider,
      model,
      contextWindow: accounting?.contextWindowTokens ?? MODEL_CONTEXT_WINDOW,
    };
    session.append("request/context", context);
    await this.ctx.sessions.flush(session);
    const runtime = this.runtimes.get(runtimeKey(agent));
    if (runtime !== undefined) {
      runtime.boundary = boundary;
      if (accounting !== undefined) runtime.context = accounting;
    }
  }

  private async createNodeAgent(
    agent: Agent,
    route: ResolvedNanocodexRoute,
    historySeed: Awaited<ReturnType<typeof buildHistorySeed>>,
    system: string,
    bridge: ToolBridge,
    quickJs: CodeEvaluator,
    resume: SessionSnapshot | undefined,
  ): Promise<NodeAgentHandle> {
    const base = {
      transport: Transport.openAi({
        apiKey: route.apiKey,
        ...(route.apiBaseUrl ? { apiBaseUrl: route.apiBaseUrl } : {}),
        ...(route.websocketUrl ? { websocketUrl: route.websocketUrl } : {}),
        websocketWarmup: true,
      }),
      model: route.model as NanocodexModel,
      ...(route.thinking ? { thinking: route.thinking } : {}),
      ...(agent.options.reasoningEffort === "pro"
        ? { reasoningMode: "pro" as const }
        : {}),
      sessionId: normalizeNanocodexSessionId(String(agent.id)),
      ...(system ? { additionalInstructions: system } : {}),
      resolveCompactionInstruction: (
        context: CompactionInstructionContext,
        signal: AbortSignal,
      ) => this.resolveCompactionInstruction(agent, route, context, signal),
      resolveCompaction: (context: CompactionContext, signal: AbortSignal) =>
        this.resolveCompaction(agent, context, signal),
      codeEvaluator: quickJs,
      tools: bridge,
      subagents: false,
      toolMode: "code" as const,
    };
    if (resume !== undefined) {
      try {
        return await NodeAgent.create({ ...base, resume });
      } catch {
        // A DSH checkpoint is an optimization over the authoritative active
        // surface. If a provider/runtime rejects it, rebuild from that surface
        // rather than allowing an opaque stale state to override DSH facts.
      }
    }
    return NodeAgent.create({
      ...base,
      ...(historySeed.history.length > 0 ||
      historySeed.continuitySummary !== undefined
        ? { historySeed }
        : {}),
    });
  }

  private async closeRuntime(runtime: LiveRuntime): Promise<void> {
    runtime.pendingCompactionPlans.length = 0;
    await runtime.nodeAgent.session.shutdown().catch(() => undefined);
    runtime.nodeAgent.dispose();
  }

  /** Run custom compaction on the already-live Nanocodex runtime. */
  async compact(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<NanocodexCompactionResult> {
    signal.throwIfAborted();
    const runtime = this.runtimeFor(agent);
    const watcher = runtime.nodeAgent.events.watch();
    let eventOutcome: CompactionReplacedEventPayload | undefined;
    let installed = false;
    let succeeded = false;
    const removeListener = watcher.onEvent((event) => {
      if (event.type === "model.compaction.replaced") installed = true;
      const replaced = parseCompactionReplacedEvent(event);
      if (replaced === undefined || replaced.trigger !== "manual") return;
      if (this.consumeCompactionOutcome(runtime, replaced)) {
        eventOutcome = replaced;
      }
    });
    const removeTransportFallback = observeTransportFallback(
      this.ctx,
      String(agent.id),
      runtime.nodeAgent,
    );
    let shutdownRequested = false;
    const abort = () => {
      shutdownRequested = true;
      void runtime.nodeAgent.session.shutdown().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const returned = await runtime.nodeAgent.session.compact();
      signal.throwIfAborted();
      if (returned === null) {
        throw new Error(
          "Nanocodex manual compaction did not produce one matching replacement event",
        );
      }
      // The accepted Nanocodex contract requires this to happen in the same
      // idle maintenance operation, immediately after compact resolves. Do
      // not derive a snapshot from outcome.context or wait for another turn.
      const snapshot = await runtime.nodeAgent.session.snapshot();
      signal.throwIfAborted();
      if (
        eventOutcome === undefined ||
        returned.revision !== eventOutcome.revision
      ) {
        throw new Error(
          "Nanocodex manual compaction did not produce one matching replacement event",
        );
      }
      const summary = returned.summary?.trim();
      if (!summary) {
        throw new Error("Nanocodex compaction returned no summary text");
      }
      const selection = await this.mapCompactionOutcome(
        agent,
        returned,
        signal,
        eventOutcome === undefined
          ? undefined
          : {
              phase: eventOutcome.phase,
              afterModelCallIndex: eventOutcome.after_model_call_index,
            },
      );
      succeeded = true;
      return {
        summary,
        outcome: returned,
        selection,
        snapshot,
        provider: runtime.provider,
        model: runtime.model,
        context: selection.context,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      removeListener();
      watcher.off();
      removeTransportFallback();
      if (shutdownRequested || (installed && !succeeded)) {
        await this.invalidate(agent).catch(() => undefined);
      }
    }
  }

  private appendRequestFacts(
    agent: Agent,
    provider: string,
    model: NanocodexModel,
    reasoningEffort: Agent["options"]["reasoningEffort"],
    system: string,
    accounting: NanocodexContextAccounting | undefined,
    bridge: readonly {
      readonly name: string;
      readonly description: string;
      readonly parameters?: Record<string, unknown> | undefined;
    }[],
  ): void {
    const tools: ToolSchema[] = bridge.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }));
    const header = canonicalHeader({
      config: {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    });
    const session = agent.session;
    const baseline = session.requestHeader();
    const hasLiveHeader = session
      .snapshotEvents(session.firstLiveSeq)
      .some((event) => event.type === "request/header");
    const previousGeneration = this.requestSurfaceGeneration.get(session);
    const startsSeries =
      previousGeneration !== undefined &&
      previousGeneration !== session.surface.replaceGeneration;
    if (!hasLiveHeader) {
      session.append("request/header", {
        header,
        reason: baseline === undefined ? "initial" : "resume",
      });
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      session.append("request/header", {
        header,
        reason: "change",
        ...(startsSeries ? { startsSeries: true } : {}),
      });
    } else if (startsSeries) {
      session.append("request/header", { header, reason: "series" });
    }
    this.requestSurfaceGeneration.set(
      session,
      session.surface.replaceGeneration,
    );
    const requestContext = {
      provider,
      model,
      contextWindow: accounting?.contextWindowTokens ?? MODEL_CONTEXT_WINDOW,
    };
    const previousContext = session.requestContext();
    if (
      previousContext?.provider !== requestContext.provider ||
      previousContext.model !== requestContext.model ||
      previousContext.contextWindow !== requestContext.contextWindow
    ) {
      session.append("request/context", requestContext);
    }
  }

  private appendToolResult(
    agent: Agent,
    turn: number,
    step: number,
    id: string,
    callSeq: SessionSeq,
    result: ToolExecutionResult,
  ): void {
    const message = createToolResultMessage({
      callId: ToolCallId(id),
      content: result.content,
      isError: result.isError,
    });
    agent.session.append(
      "tool/result",
      {
        turn,
        step,
        message,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
      },
      { surfaceOp: "append", sourceEventSeqs: [callSeq] },
    );
  }
}
