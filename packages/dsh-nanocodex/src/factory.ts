import type { Context } from "@deepseek-ai/cordis";
import {
  emitAgentEvent,
  type AgentFactory,
  type AgentHandle,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import { apply as applyCompactCommand } from "@deepseek-ai/dsh-command-compact";
import { SessionPreparation } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { NanocodexAgent } from "./agent.js";
import { NanocodexEngine } from "./engine.js";

interface PreparedAgent {
  readonly agent: NanocodexAgent;
  readonly dispose: () => Promise<void>;
}

/** AgentFactory implementation installed by the selected Cordis row. */
export class NanocodexFactory implements AgentFactory {
  private readonly engine: NanocodexEngine;
  private readonly live = new Set<PreparedAgent>();
  private closed = false;

  constructor(
    private readonly ctx: Context,
    engine: NanocodexEngine,
  ) {
    this.engine = engine;
  }

  async createAgent(
    ownerCtx: Context,
    options: CreateAgentOptions,
  ): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(
      this.ctx.sessions.prepare(options.sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.inheritedEventCount === undefined
          ? {}
          : { inheritedEventCount: options.inheritedEventCount }),
      }),
    );
    try {
      return await this.publish(
        ownerCtx,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        "startup",
      );
    } finally {
      preparation[Symbol.dispose]();
    }
  }

  async resume(
    ownerCtx: Context,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const persistence = this.ctx.get("sessionPersistence") as
      | SessionPersistence
      | undefined;
    if (persistence === undefined) {
      throw new Error(
        "cannot resume Nanocodex: dsh-session-persistence is not configured",
      );
    }
    const preparation = await persistence.prepare(
      options.resumeSessionId,
      options.signal,
    );
    try {
      return await this.publish(
        ownerCtx,
        preparation,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        "resume",
      );
    } finally {
      preparation[Symbol.dispose]();
    }
  }

  async disposeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live].map((entry) => entry.dispose()));
  }

  private async publish(
    ownerCtx: Context,
    preparation: SessionPreparation,
    options: CreateAgentOptions["agentOptions"],
    setup: CreateAgentOptions["setup"],
    callerSignal: AbortSignal | undefined,
    source: "startup" | "resume",
  ): Promise<AgentHandle> {
    if (this.closed) throw new Error("Nanocodex factory is no longer active");
    const agent = new NanocodexAgent(
      this.ctx,
      preparation.session.id,
      options ?? {},
      preparation.session,
      this.engine,
    );
    let detachSession: (() => void) | undefined;
    let detachAgent: (() => void) | undefined;
    let disposed: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposed ??= (async () => {
        agent.cancel({ kind: "disposed" });
        await agent.whenIdle();
        detachAgent?.();
        detachSession?.();
        await agent.dispose();
        this.live.delete(entry);
      })();
      return disposed;
    };
    const entry: PreparedAgent = { agent, dispose };
    this.live.add(entry);

    // The caller's fiber owns the entire publication lifetime. The callback is
    // registered before setup so an unload during setup cannot publish a ghost.
    ownerCtx.effect(
      () => () => dispose(),
      `dsh-nanocodex.lifecycle(${String(agent.id)})`,
    );

    try {
      if (callerSignal?.aborted) throw callerSignal.reason;
      const commit = await setup?.(agent.ctx);
      applyCompactCommand(agent.ctx);
      if (commit) commit.commit();
      if (callerSignal?.aborted) throw callerSignal.reason;
      detachSession = agent.ctx.sessions.enter(preparation.session);
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent);
      agent.ctx.sessions.announce(preparation.session);
      this.ctx.agents.announce(agent);
      emitAgentEvent(this.ctx, agent, "agent/session-start", { source });
      return { agent, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}
