import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
  type CompactionAgentContext,
  type CompactionResult,
  type ManualCompactAgentContext,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type Session } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  NanocodexEngine,
  type NanocodexCompactionSelection,
  type NanocodexAutomaticCompaction,
} from "./engine.js";

type CommandId = NonNullable<Parameters<typeof compactCheckpointSource>[1]>;

interface Selection {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
  readonly shadowedSeqs: SessionSeq[];
}

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

function supportedPrefix(session: Session): Selection | null {
  const nodes = [...session.surface.nodes];
  const messages = session.deriveMessages();
  if (nodes.length !== messages.length) {
    throw new Error(
      "Nanocodex compaction cannot select a mismatched DSH surface",
    );
  }
  let retainedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.source.kind === "user") {
      retainedIndex = index;
      break;
    }
  }
  if (retainedIndex <= 0) return null;
  const start = nodes[0];
  const end = nodes[retainedIndex - 1];
  if (
    start === undefined ||
    end === undefined ||
    !toolPairingBalancedBefore(session, start) ||
    !toolPairingBalancedAfter(session, end)
  ) {
    throw new Error(
      "Nanocodex compaction prefix would split a DSH tool exchange",
    );
  }
  return {
    start,
    end,
    shadowedSeqs: nodes.slice(0, retainedIndex),
  };
}

function sameSelection(
  left: Selection,
  right: NanocodexCompactionSelection,
): boolean {
  return (
    left.start === right.shadowedRange.start &&
    left.end === right.shadowedRange.end &&
    left.shadowedSeqs.length === right.shadowedSeqs.length &&
    left.shadowedSeqs.every((seq, index) => right.shadowedSeqs[index] === seq)
  );
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
 * Minimal DSH compaction owner. The checkpoint is model-private and lands only
 * as the normal non-expandable compact checkpoint message. The selected range
 * and all transaction markers remain fully durable in DSH's event log.
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
    // Nanocodex owns automatic pressure/overflow detection and carries its
    // exact private boundary back through EngineRunResult. DSH's generic
    // trigger has no corresponding engine boundary, so selecting an arbitrary
    // surface suffix here could discard facts the engine retained.
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
        const selection = supportedPrefix(agent.session);
        if (selection === null) return null;
        let committed = false;
        try {
          const result = await this.compactSelection(
            agent,
            selection,
            operationSignal,
            sourceCommandId,
          );
          committed = true;
          await this.ctx.sessions.flush(agent.session);
          return result;
        } catch (error) {
          if (committed) {
            await this.engine.invalidate(agent as Agent).catch(() => undefined);
          }
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

  async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CompactionResult> {
    const maintenanceAgent = agent as CompactionAgentContext & {
      runMaintenance: ManualCompactAgentContext["runMaintenance"];
    };
    if (typeof maintenanceAgent.runMaintenance !== "function") {
      throw new ManualCompactionError(
        "busy",
        "region compaction requires an idle agent maintenance boundary",
      );
    }
    const initialNodes = [...agent.session.surface.nodes];
    const initialStartIndex = initialNodes.indexOf(start);
    const initialEndIndex = initialNodes.indexOf(end);
    const initialSupported = supportedPrefix(agent.session);
    if (
      initialStartIndex < 0 ||
      initialEndIndex < initialStartIndex ||
      initialSupported === null ||
      initialSupported.start !== start ||
      initialSupported.end !== end ||
      initialSupported.shadowedSeqs.length !==
        initialEndIndex - initialStartIndex + 1 ||
      initialSupported.shadowedSeqs.some(
        (seq, index) => initialNodes[initialStartIndex + index] !== seq,
      )
    ) {
      throw new ManualCompactionError(
        "changed",
        "Nanocodex compactRegion only supports the current prefix before the latest real user tail",
      );
    }
    let cancelled = false;
    let cancellationReason: unknown;
    try {
      return await maintenanceAgent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal]);
        operationSignal.throwIfAborted();
        const nodes = [...agent.session.surface.nodes];
        const startIndex = nodes.indexOf(start);
        const endIndex = nodes.indexOf(end);
        if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
          throw new Error(
            "Nanocodex compaction range is not a current surface span",
          );
        }
        const supported = supportedPrefix(agent.session);
        if (
          supported === null ||
          supported.start !== start ||
          supported.end !== end ||
          supported.shadowedSeqs.length !== endIndex - startIndex + 1 ||
          supported.shadowedSeqs.some(
            (seq, index) => nodes[startIndex + index] !== seq,
          )
        ) {
          throw new ManualCompactionError(
            "changed",
            "Nanocodex compactRegion only supports the current prefix before the latest real user tail",
          );
        }
        let committed = false;
        try {
          const result = await this.compactSelection(
            agent,
            {
              start,
              end,
              shadowedSeqs: nodes.slice(startIndex, endIndex + 1),
            },
            operationSignal,
          );
          committed = true;
          await this.ctx.sessions.flush(agent.session);
          return result;
        } catch (error) {
          if (committed) {
            await this.engine.invalidate(agent as Agent).catch(() => undefined);
          }
          if (operationSignal.aborted) {
            cancelled = true;
            cancellationReason = operationSignal.reason;
            throw operationSignal.reason;
          }
          throw error;
        }
      });
    } catch (error) {
      if (cancelled || signal.aborted) {
        throw cancellationReason ?? signal.reason;
      }
      if (error instanceof ManualCompactionError) throw error;
      throw new ManualCompactionError(
        "summary",
        "Nanocodex could not create a continuity checkpoint",
        { cause: error },
      );
    }
  }

  /**
   * Commit a summary produced by Nanocodex's automatic private compaction.
   * Nanocodex owns the model call; DSH still owns the durable surface and the
   * non-expandable checkpoint visible to Companion.
   */
  async commitAutomaticSummary(
    agent: CompactionAgentContext,
    automatic: NanocodexAutomaticCompaction,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
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
        {
          start: selection.shadowedRange.start,
          end: selection.shadowedRange.end,
          shadowedSeqs: [...selection.shadowedSeqs],
        },
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
    selection: Selection,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult> {
    signal.throwIfAborted();
    const attempt = this.beginCompaction(agent, sourceCommandId);
    let generated = false;
    try {
      const result = await this.engine.compact(agent as Agent, signal);
      generated = true;
      if (!sameSelection(selection, result.selection)) {
        throw new ManualCompactionError(
          "changed",
          "Nanocodex compacted a different DSH prefix than the requested range",
        );
      }
      const committed = this.commitSummary(
        agent,
        selection,
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
      );
      return committed;
    } catch (error) {
      this.endFailedCompaction(agent, attempt, error);
      if (generated)
        await this.engine.invalidate(agent as Agent).catch(() => undefined);
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
      // Preserve the original summary/commit failure if closing the marker
      // itself fails; persistence recovery can still see the open attempt.
    } finally {
      attempt.ended = true;
    }
  }

  private commitSummary(
    agent: CompactionAgentContext,
    selection: Selection,
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
    signal.throwIfAborted();
    const summaryEvent = agent.session.append("compaction/summary", {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      summary,
      rawOutput: summary,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: selection.shadowedSeqs,
      shadowedTokenCount: Math.max(
        1,
        Math.ceil(textOfBlocks(summary).length / 4),
      ),
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
        start: selection.start,
        end: selection.end,
      },
      sourceEventSeqs: [
        attempt.startSeq,
        summaryEvent.seq,
        ...selection.shadowedSeqs,
      ],
    });
    const endEvent = agent.session.append("compaction/end", {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      turn: attempt.turn,
    });
    attempt.ended = true;
    const shadowedTokenCount = Math.max(
      1,
      Math.ceil(textOfBlocks(summary).length / 4),
    );
    return {
      compactionId: attempt.compactionId,
      ...(attempt.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: attempt.sourceCommandId }),
      startSeq: attempt.startSeq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    };
  }
}

function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}
