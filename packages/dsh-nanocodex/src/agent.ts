import type { Context } from "@deepseek-ai/cordis";
import {
  Inbox,
  agentEvents,
  assembleContextFor,
  type Agent,
  type AgentStatus,
  type CancelOptions,
  type PreStepDecision,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import type { AgentCancelCause, Session } from "@deepseek-ai/dsh-session";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import {
  joinContextSections,
  renderContextSections,
  type PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import { closeInterruptedToolCalls } from "./interrupted-tools.js";
import { NanocodexEngine } from "./engine.js";
import type { NanocodexCompactionEngine } from "./compaction-engine.js";

type Phase =
  | { kind: "idle"; lastTurn: number }
  | {
      kind: "running";
      abort: AbortController;
      turn: number;
      step: number;
      wakeRequested: boolean;
    }
  | {
      kind: "maintenance";
      abort: AbortController;
      lastTurn: number;
      wakeRequested: boolean;
    };

interface PreStepResult {
  readonly decision: PreStepDecision;
  readonly assembly?: PromptAssembly;
}

const RUNTIME_CONTEXT_SOURCE = "@deepseek-ai/dsh-system-prompt";
const CLEARED_RUNTIME_CONTEXT =
  "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function lastTurn(session: Session): number {
  let result = 0;
  for (const event of session.snapshotEvents()) {
    if (event.type === "turn/start") result = Math.max(result, event.data.turn);
  }
  return result;
}

function cancelCause(signal: AbortSignal): AgentCancelCause {
  const reason = signal.reason;
  if (
    reason &&
    typeof reason === "object" &&
    "kind" in reason &&
    ((reason as { kind?: unknown }).kind === "user" ||
      (reason as { kind?: unknown }).kind === "parent" ||
      (reason as { kind?: unknown }).kind === "disposed" ||
      (reason as { kind?: unknown }).kind === "hook")
  ) {
    return reason as AgentCancelCause;
  }
  return {
    kind: "hook",
    reason:
      reason instanceof Error ? reason.message : String(reason ?? "aborted"),
  };
}

function errorInfo(error: unknown): { message: string; code: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: "UNKNOWN",
  };
}

/**
 * DSH's public Agent handle backed by Nanocodex turns. DSH owns the queue and
 * durable log; each model step is hydrated from the active surface.
 */
export class NanocodexAgent implements Agent {
  readonly id: Agent["id"];
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: Inbox;
  readonly ctx: Context;

  private readonly loopCtx: Context;
  private readonly engine: NanocodexEngine;
  private readonly scope: Scope;
  private readonly dispatch: ReturnType<typeof agentEvents>;
  private phase: Phase;
  private activityDone: Promise<void> = Promise.resolve();
  private runtimeContextText: string | null | undefined;

  constructor(
    loopCtx: Context,
    id: Agent["id"],
    options: AgentOptions,
    session: Session,
    engine: NanocodexEngine,
  ) {
    this.loopCtx = loopCtx;
    this.id = id;
    this.options = options;
    this.session = session;
    closeInterruptedToolCalls(session);
    this.engine = engine;
    this.dispatch = agentEvents(loopCtx, this);
    this.inbox = new Inbox(session, {
      inserted: (message) =>
        this.dispatch.emit("agent/inbox/inserted", { message }),
      discarded: (message) =>
        this.dispatch.emit("agent/inbox/discarded", { message }),
      claimed: (message, turn) =>
        this.dispatch.emit("agent/inbox/claimed", { message, turn }),
    });
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx.extend({ agent: this });
    this.phase = { kind: "idle", lastTurn: lastTurn(session) };
    this.runtimeContextText = this.findRuntimeContext();
  }

  get status(): AgentStatus {
    return this.phase.kind === "running" ? "running" : "idle";
  }

  send(
    message: UserMessage,
    target: "next-turn" | "next-step",
    wakeup: boolean,
  ): void {
    const wakingAfterAbort =
      wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    this.inbox.splice(wakingAfterAbort ? "next-turn" : target, Infinity, 0, [
      message,
    ]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
  }

  followup(message: UserMessage): void {
    this.send(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    this.send(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    this.send(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear();
      if (this.phase.kind !== "idle") this.phase.wakeRequested = false;
    } else if (this.phase.kind !== "idle" && this.inbox.hasPending) {
      // A user stop cancels the active model call but ordinary follow-ups
      // remain admitted and must wake the driver after the abort settles.
      this.phase.wakeRequested = true;
    }
    if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
  }

  whenIdle(): Promise<void> {
    return this.waitForIdle();
  }

  private async waitForIdle(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.activityDone;
      await observed;
    } while (observed !== this.activityDone);
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== "idle") {
      throw new Error(`agent "${String(this.id)}" already has active work`);
    }
    const done = deferred<void>();
    const maintenance: Extract<Phase, { kind: "maintenance" }> = {
      kind: "maintenance",
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    };
    this.phase = maintenance;
    this.activityDone = done.promise;
    return (async () => {
      try {
        return await task(maintenance.abort.signal);
      } finally {
        this.phase = { kind: "idle", lastTurn: maintenance.lastTurn };
        if (maintenance.wakeRequested && this.inbox.hasPending)
          this.wakeDriver();
        done.resolve();
      }
    })();
  }

  wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== "idle") {
      if (
        this.phase.abort.signal.reason?.kind !== "disposed" &&
        (this.phase.kind === "maintenance" || wakeAfterAbort)
      ) {
        this.phase.wakeRequested = true;
      }
      return;
    }
    const done = deferred<void>();
    const running: Extract<Phase, { kind: "running" }> = {
      kind: "running",
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    };
    this.phase = running;
    this.activityDone = done.promise;
    this.dispatch.emit("agent/status", { status: "running" });
    this.loopCtx.agents
      .withInitiator(this, () => this.kick())
      .then(
        () => done.resolve(),
        (error) => {
          this.dispatch.emit("agent/error", {
            turn: running.turn,
            step: running.step,
            error,
          });
          done.resolve();
        },
      );
  }

  async dispose(): Promise<void> {
    this.cancel({ kind: "disposed" });
    await this.waitForIdle();
    await this.engine.dispose(this);
    await this.scope.dispose();
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {
        // Drain ordinary follow-ups in the same owned driver.
      }
    } catch (error) {
      const phase = this.phase;
      this.dispatch.emit("agent/error", {
        turn: phase.kind === "running" ? phase.turn : phase.lastTurn,
        step: phase.kind === "running" ? phase.step : 0,
        error,
      });
    } finally {
      if (this.phase.kind === "running") {
        const { turn, wakeRequested } = this.phase;
        this.phase = { kind: "idle", lastTurn: turn };
        this.dispatch.emit("agent/status", { status: "idle" });
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver();
      }
    }
  }

  private async preStep(
    target: "next-turn" | "next-step",
    turn: number,
    step: number,
  ): Promise<PreStepResult> {
    if (this.phase.kind !== "running")
      throw new Error("pre-step outside running phase");
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, turn);
    const assembly = await this.loopCtx.systemPrompt.assemble(
      assembleContextFor(this, signal),
    );
    signal.throwIfAborted();
    const sections = renderContextSections(assembly);
    // A compaction or another surface replacement may have shadowed the last
    // projected runtime-context message while this Agent stayed alive. Re-read
    // the authoritative active surface before deciding whether to append a new
    // snapshot, matching DSH's replacement semantics rather than retaining a
    // stale in-memory marker.
    this.runtimeContextText = this.findRuntimeContext();
    const runtime = this.projectRuntimeContext(
      joinContextSections(sections),
      sections,
    );
    const decision = await this.dispatch.waterfall(
      "agent/pre-step",
      { messages: claimed, turn, step, signal },
      () =>
        Promise.resolve<PreStepDecision>({
          kind: "enter",
          messages: runtime === undefined ? claimed : [...claimed, runtime],
        }),
    );
    signal.throwIfAborted();
    return decision.kind === "reject" ? { decision } : { decision, assembly };
  }

  private async turn(): Promise<boolean> {
    if (this.phase.kind !== "running")
      throw new Error("turn without driver reservation");
    const phase = this.phase;
    const signal = phase.abort.signal;
    signal.throwIfAborted();
    const turn = phase.turn + 1;
    phase.turn = turn;
    this.session.append("turn/start", { turn });
    let reason:
      | { kind: "completed" }
      | { kind: "blocked" }
      | { kind: "aborted"; reason: AgentCancelCause }
      | { kind: "error"; error: { message: string; code: string } } = {
      kind: "completed",
    };
    let target: "next-turn" | "next-step" = "next-turn";
    try {
      while (true) {
        signal.throwIfAborted();
        const step = phase.step + 1;
        const prepared = await this.preStep(target, turn, step);
        if (prepared.decision.kind === "reject") {
          reason = { kind: "blocked" };
          break;
        }
        const messages = prepared.decision.messages;
        if (phase.step === 0 && messages.length === 0) break;
        signal.throwIfAborted();
        const previousMessages = this.session.deriveMessages();
        this.session.append("step/start", { turn, step });
        phase.step = step;
        try {
          for (const message of messages) {
            this.session.append("user/message", message, {
              surfaceOp: "append",
            });
          }
          const engineResult = await this.engine.run(
            this,
            previousMessages,
            messages,
            prepared.assembly!,
            turn,
            step,
            signal,
            () => {
              this.session.append("step/end", { turn, step: phase.step });
              phase.step += 1;
              this.session.append("step/start", { turn, step: phase.step });
              return phase.step;
            },
          );
          if (engineResult.automaticCompactions.length > 0) {
            const compaction = this.loopCtx.compaction as
              | NanocodexCompactionEngine
              | undefined;
            if (
              compaction === undefined ||
              typeof compaction.commitAutomaticSummary !== "function"
            ) {
              throw new Error(
                "Nanocodex automatic compaction has no DSH compaction owner",
              );
            }
            for (const automatic of engineResult.automaticCompactions) {
              await compaction.commitAutomaticSummary(this, automatic, signal);
            }
          }
          try {
            await this.engine.persistCheckpoint(
              this,
              engineResult.provider,
              engineResult.model,
              engineResult.snapshot,
              signal,
              engineResult.context,
            );
          } catch (error) {
            await this.engine.invalidate(this).catch(() => undefined);
            throw error;
          }
        } finally {
          this.session.append("step/end", { turn, step: phase.step });
        }
        reason = { kind: "completed" };
        signal.throwIfAborted();
        if (this.inbox.nextStep.length === 0) {
          await this.dispatch.serial("agent/turn-stopping", { turn, signal });
          signal.throwIfAborted();
        }
        if (this.inbox.nextStep.length === 0) break;
        target = "next-step";
      }
    } catch (error) {
      if (signal.aborted)
        reason = { kind: "aborted", reason: cancelCause(signal) };
      else {
        reason = { kind: "error", error: errorInfo(error) };
        this.dispatch.emit("agent/error", { turn, step: phase.step, error });
      }
    } finally {
      this.session.append("turn/end", { turn, reason });
    }
    if (
      !signal.aborted &&
      reason.kind === "completed" &&
      this.inbox.hasPending
    ) {
      phase.abort = new AbortController();
      phase.step = 0;
      phase.wakeRequested = false;
      return true;
    }
    return false;
  }

  private findRuntimeContext(): string | null | undefined {
    for (const message of this.session.deriveMessages().reverse()) {
      if (
        message.source.kind === "plugin" &&
        message.source.plugin === RUNTIME_CONTEXT_SOURCE &&
        message.content.length === 1 &&
        message.content[0]?.type === "text"
      ) {
        return message.content[0].text;
      }
    }
    return undefined;
  }

  private projectRuntimeContext(
    current: string,
    sections: ReturnType<typeof renderContextSections>,
  ): UserMessage | undefined {
    if (this.runtimeContextText === undefined && current.length === 0)
      return undefined;
    const next = current.length === 0 ? CLEARED_RUNTIME_CONTEXT : current;
    if (this.runtimeContextText === next) return undefined;
    this.runtimeContextText = next;
    return createUserMessage({
      content: [{ type: "text", text: next }],
      source:
        sections.length === 0
          ? { kind: "plugin", plugin: RUNTIME_CONTEXT_SOURCE }
          : {
              kind: "plugin",
              plugin: RUNTIME_CONTEXT_SOURCE,
              form: "snapshot",
              sections,
            },
    });
  }
}
