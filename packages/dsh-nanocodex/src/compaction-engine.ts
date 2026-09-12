import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  type CompactionAgentContext,
  type CompactionResult,
  type ManualCompactAgentContext,
} from "@deepseek-ai/dsh-compaction";
import {
  createUserMessage,
  type AssistantMessage,
  type ContentBlock,
  type Message,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-token-meter";
import {
  NanocodexEngine,
  type NanocodexAutomaticCompaction,
  type NanocodexCompactionSelection,
} from "./engine.js";
import {
  compactionPlaceholderMessage,
  type NanocodexCompactionSurfaceSegment,
} from "./compaction-policy.js";

type CommandId = NonNullable<Parameters<typeof compactCheckpointSource>[1]>;

interface CompactionAttempt {
  readonly compactionId: ReturnType<typeof CompactionId>;
  readonly sourceCommandId?: CommandId;
  readonly turn: number | null;
  readonly startSeq: SessionSeq;
  ended: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openTurn(session: Session): number | null {
  let turn: number | null = null;
  for (const event of session.snapshotEvents()) {
    if (event.type === "turn/start") turn = event.data.turn;
    if (event.type === "turn/end" && turn === event.data.turn) turn = null;
  }
  return turn;
}

/**
 * DSH lifecycle owner for Nanocodex's host-selected private compaction.
 * Nanocodex owns summary generation and the private checkpoint; DSH owns the
 * durable transcript surface and records each exact filtered span.
 */
export class NanocodexCompactionEngine extends CompactionEngine {
  constructor(
    ctx: Context,
    private readonly engine: NanocodexEngine,
  ) {
    super(ctx);
  }

  async compactIfNeeded(
    agent: CompactionAgentContext,
    _trigger: "pressure" | "context-overflow",
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    // Nanocodex admits automatic pressure and overflow compaction itself. The
    // generic DSH trigger has no operation snapshot with which to make the
    // same host selection, so it must not guess a surface range.
    void agent;
    return null;
  }

  async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    let cancelled = false;
    let cancellationReason: unknown;
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        operationSignal.throwIfAborted();
        try {
          const result = await this.compactSelection(
            agent,
            operationSignal,
            sourceCommandId,
          );
          await this.ctx.sessions.flush(agent.session);
          return result;
        } catch (error) {
          if (operationSignal.aborted) {
            cancelled = true;
            cancellationReason = operationSignal.reason;
            throw operationSignal.reason;
          }
          throw new ManualCompactionError(
            "summary",
            "Nanocodex could not create a continuity checkpoint",
            { cause: error },
          );
        }
      });
    } catch (error) {
      if (cancelled || signal.aborted) {
        throw cancellationReason ?? signal.reason;
      }
      if (error instanceof ManualCompactionError) throw error;
      throw new ManualCompactionError(
        "busy",
        "manual compaction requires an idle agent",
        { cause: error },
      );
    }
  }

  /**
   * The host policy owns the complete selected replacement. An explicit range
   * cannot be translated into that immutable Nanocodex operation snapshot, so
   * reject it before starting maintenance or touching the session.
   */
  async compactRegion(
    _start: SessionSeq,
    _end: SessionSeq,
    _agent: CompactionAgentContext,
    _signal: AbortSignal = new AbortController().signal,
  ): Promise<CompactionResult> {
    throw new ManualCompactionError(
      "changed",
      "Nanocodex compaction uses its complete host-selected surface policy; use compactNow",
    );
  }

  /** Commit one automatic outcome after Nanocodex has installed its private history. */
  async commitAutomaticSummary(
    agent: CompactionAgentContext,
    automatic: NanocodexAutomaticCompaction,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    const summary = automatic.outcome.summary?.trim() ?? "";
    if (!summary) {
      await this.engine.invalidate(agent as Agent).catch(() => undefined);
      throw new Error(
        "Nanocodex automatic compaction returned an empty summary",
      );
    }
    let selection: NanocodexCompactionSelection;
    try {
      selection = await this.engine.mapCompactionOutcome(
        agent,
        automatic.outcome,
        signal,
        automatic,
      );
    } catch (error) {
      await this.engine.invalidate(agent as Agent).catch(() => undefined);
      throw error;
    }
    const attempt = this.beginCompaction(agent);
    let committed = false;
    try {
      const result = this.commitSummary(
        agent,
        selection,
        [{ type: "text", text: summary }],
        signal,
        attempt,
      );
      committed = true;
      return result;
    } catch (error) {
      this.endFailedCompaction(agent, attempt, error);
      await this.engine.invalidate(agent as Agent).catch(() => undefined);
      throw error;
    } finally {
      if (committed) this.engine.markSurfaceBoundary(agent as Agent);
    }
  }

  private async compactSelection(
    agent: CompactionAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted();
    const attempt = this.beginCompaction(agent, sourceCommandId);
    let generated = false;
    try {
      const result = await this.engine.compact(agent as Agent, signal);
      generated = true;
      if (result.selection.segments.length === 0) {
        const noOp = new Error(
          "Nanocodex compaction found no safe DSH surface reduction",
        );
        this.endFailedCompaction(agent, attempt, noOp);
        await this.engine.invalidate(agent as Agent).catch(() => undefined);
        return null;
      }
      const committed = this.commitSummary(
        agent,
        result.selection,
        [{ type: "text", text: result.summary }],
        signal,
        attempt,
      );
      this.engine.markSurfaceBoundary(agent as Agent);
      await this.engine.persistCheckpoint(
        agent as Agent,
        result.provider,
        result.model,
        result.snapshot,
        signal,
        result.context,
      );
      return committed;
    } catch (error) {
      this.endFailedCompaction(agent, attempt, error);
      if (generated) {
        await this.engine.invalidate(agent as Agent).catch(() => undefined);
      }
      throw error;
    }
  }

  private beginCompaction(
    agent: CompactionAgentContext,
    sourceCommandId?: CommandId,
  ): CompactionAttempt {
    const lifecycle = {
      compactionId: CompactionId(randomUUID()),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      turn: openTurn(agent.session),
    };
    const startEvent = agent.session.append("compaction/start", lifecycle);
    return { ...lifecycle, startSeq: startEvent.seq, ended: false };
  }

  private endFailedCompaction(
    agent: CompactionAgentContext,
    attempt: CompactionAttempt,
    error: unknown,
  ): void {
    if (attempt.ended) return;
    try {
      agent.session.append("compaction/end", {
        compactionId: attempt.compactionId,
        ...(attempt.sourceCommandId === undefined
          ? {}
          : { sourceCommandId: attempt.sourceCommandId }),
        turn: attempt.turn,
        error: errorText(error),
      });
    } catch {
      // Preserve the original failure if the closing marker also fails.
    } finally {
      attempt.ended = true;
    }
  }

  private commitSummary(
    agent: CompactionAgentContext,
    selection: NanocodexCompactionSelection,
    summary: ContentBlock[],
    signal: AbortSignal,
    attempt: CompactionAttempt,
  ): CompactionResult {
    signal.throwIfAborted();
    const provider = agent.options.provider;
    const model = agent.options.model;
    if (!provider || !model) {
      throw new Error(
        "Nanocodex compaction requires an explicit provider/model",
      );
    }
    const summaryIndex = selection.segments.findIndex(
      (segment) => segment.kind === "remove",
    );
    if (summaryIndex < 0) {
      throw new Error(
        "Nanocodex compaction has no removable surface span for its private summary",
      );
    }
    // All segments are measured against the same pre-installation surface.
    // Replacements below intentionally make the original sequence IDs stale,
    // so the aggregate shadow price must be captured before the first DSH
    // surface mutation.
    const shadowedTokenCount = this.estimateShadowedTokens(
      agent.session,
      selection.shadowedSeqs,
    );

    // A text-only rewrite before the summary is still a model-free prune. It
    // must be paired with its own shadow price before the summary event, while
    // the summary itself remains immediately adjacent to its checkpoint.
    for (const segment of selection.segments.slice(0, summaryIndex)) {
      this.commitPrune(agent, segment, signal);
    }

    const summarySegment = selection.segments[summaryIndex]!;
    const summaryTokenCount = this.estimateShadowedTokens(
      agent.session,
      summarySegment.shadowedSeqs,
    );
    const summaryEvent = agent.session.append("compaction/summary", {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      summary,
      rawOutput: summary,
      shadowedRange: {
        start: summarySegment.start,
        end: summarySegment.end,
      },
      shadowedSeqs: [...summarySegment.shadowedSeqs],
      shadowedTokenCount: summaryTokenCount,
      provider,
      model,
    });
    const checkpoint = createUserMessage({
      content: summary,
      source: compactCheckpointSource(
        attempt.compactionId,
        attempt.sourceCommandId,
      ),
    });
    agent.session.append("user/message", checkpoint, {
      surfaceOp: {
        op: "replace",
        start: summarySegment.start,
        end: summarySegment.end,
      },
      sourceEventSeqs: [
        attempt.startSeq,
        summaryEvent.seq,
        ...summarySegment.shadowedSeqs,
      ],
    });

    for (const segment of selection.segments.slice(summaryIndex + 1)) {
      this.commitPrune(agent, segment, signal);
    }

    const endEvent = agent.session.append("compaction/end", {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      turn: attempt.turn,
    });
    attempt.ended = true;
    return {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      startSeq: attempt.startSeq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary,
      shadowedRange: {
        start: summarySegment.start,
        end: summarySegment.end,
      },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    };
  }

  private commitPrune(
    agent: CompactionAgentContext,
    segment: NanocodexCompactionSurfaceSegment,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    const shadowedTokenCount = this.estimateShadowedTokens(
      agent.session,
      segment.shadowedSeqs,
    );
    const prune = agent.session.append("compaction/prune", {
      shadowedRange: { start: segment.start, end: segment.end },
      shadowedSeqs: [...segment.shadowedSeqs],
      shadowedTokenCount,
    });
    const message =
      segment.kind === "replace" && segment.message !== undefined
        ? segment.message
        : compactionPlaceholderMessage();
    this.appendSurfaceReplacement(agent.session, segment, message, [
      prune.seq,
      ...segment.shadowedSeqs,
    ]);
  }

  private appendSurfaceReplacement(
    session: Session,
    segment: NanocodexCompactionSurfaceSegment,
    message: Message,
    sourceEventSeqs: readonly SessionSeq[],
  ): void {
    const original = session.eventAt(segment.start);
    if (message.role === "user") {
      session.append("user/message", message as UserMessage, {
        surfaceOp: {
          op: "replace",
          start: segment.start,
          end: segment.end,
        },
        sourceEventSeqs: [...sourceEventSeqs],
      });
      return;
    }
    if (
      original?.type === "assistant/message" &&
      message.role === "assistant"
    ) {
      session.append(
        "assistant/message",
        {
          turn: original.data.turn,
          step: original.data.step,
          message: message as AssistantMessage,
        },
        {
          surfaceOp: {
            op: "replace",
            start: segment.start,
            end: segment.end,
          },
          sourceEventSeqs: [...sourceEventSeqs],
        },
      );
      return;
    }
    throw new Error(
      "Nanocodex compaction replacement does not begin at a user or assistant surface event",
    );
  }

  private estimateShadowedTokens(
    session: Session,
    shadowedSeqs: readonly SessionSeq[],
  ): number {
    const nodes = [...session.surface.nodes];
    const messages = session.deriveMessages();
    if (nodes.length !== messages.length) {
      throw new Error(
        "Nanocodex compaction cannot estimate a mismatched DSH surface",
      );
    }
    const selected = new Set(shadowedSeqs);
    if (selected.size !== shadowedSeqs.length) {
      throw new Error(
        "Nanocodex compaction cannot estimate duplicate surface nodes",
      );
    }
    let matched = 0;
    let total = 0;
    for (const [index, seq] of nodes.entries()) {
      if (!selected.has(seq)) continue;
      const message = messages[index];
      if (message === undefined) {
        throw new Error(
          "Nanocodex compaction cannot estimate a missing surface message",
        );
      }
      total += this.ctx.tokenMeter.estimateMessage(message);
      matched += 1;
    }
    if (matched !== selected.size) {
      throw new Error(
        "Nanocodex compaction cannot estimate a stale surface selection",
      );
    }
    return total;
  }
}
