import {
  createToolResultMessage,
  type ToolCallBlock,
} from "@deepseek-ai/dsh-llm";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import { INTERRUPTED_TOOL_OUTPUT } from "./constants.js";

/** Close admitted calls at a stopped driver boundary without replaying them. */
export function closeInterruptedToolCalls(
  session: Session,
  failure?: unknown,
): void {
  const calls = new Map<
    string,
    { block: ToolCallBlock; turn: number; step: number }
  >();
  const results = new Set<string>();
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      for (const block of event.data.message.content) {
        if (block.type !== "tool-call") continue;
        const id = String(block.id);
        if (calls.has(id))
          throw new Error(
            `Cannot recover duplicate tool call ${JSON.stringify(id)}`,
          );
        calls.set(id, { block, turn: event.data.turn, step: event.data.step });
      }
    } else if (event?.type === "tool/result") {
      results.add(String(event.data.message.source.callId));
    }
  }
  for (const id of results) calls.delete(id);
  if (calls.size === 0) return;

  const callSeqs = new Map<string, SessionSeq>();
  for (const event of session.snapshotEvents()) {
    if (event.type !== "tool/call") continue;
    const pending = calls.get(String(event.data.callId));
    if (pending?.turn === event.data.turn && pending.step === event.data.step) {
      callSeqs.set(String(event.data.callId), event.seq);
    }
  }
  const cause = failure instanceof Error ? failure.message : String(failure);
  const text =
    failure === undefined
      ? INTERRUPTED_TOOL_OUTPUT
      : `${INTERRUPTED_TOOL_OUTPUT}\nCause: ${cause.slice(0, 1024)}`;
  for (const [id, { block, turn, step }] of calls) {
    const callSeq =
      callSeqs.get(id) ??
      session.append("tool/call", {
        turn,
        step,
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
      }).seq;
    session.append(
      "tool/result",
      {
        turn,
        step,
        message: createToolResultMessage({
          callId: block.id,
          content: [{ type: "text", text }],
          isError: true,
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [callSeq] },
    );
  }
}
