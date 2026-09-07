import type { TranscriptTurn } from "./types.js";

type DshEvent = {
  type?: string;
  time?: number;
  data?: unknown;
};

type DshMessage = {
  content?: Array<{ type?: string; text?: string }>;
  source?: { kind?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type?: string; text?: string } => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function isHumanMessage(message: unknown): boolean {
  return isRecord(message) && isRecord(message.source) && message.source.kind === "user";
}

export function recentUserText(events: readonly DshEvent[] | undefined, count: number): string[] {
  const texts: string[] = [];
  for (const event of events ?? []) {
    if (event.type !== "user/message" || !isHumanMessage(event.data)) continue;
    const text = textOf(event.data);
    if (text) texts.push(text);
  }
  return texts.slice(-count);
}

export function transcriptForTurn(events: readonly DshEvent[] | undefined, targetTurn: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let activeTurn: number | undefined;
  for (const event of events ?? []) {
    if (event.type === "turn/start" && isRecord(event.data) && typeof event.data.turn === "number") {
      activeTurn = event.data.turn;
      continue;
    }
    if (activeTurn !== targetTurn) continue;
    const timestamp = typeof event.time === "number" ? new Date(event.time).toISOString() : undefined;
    if (event.type === "user/message" && isHumanMessage(event.data)) {
      const content = textOf(event.data);
      if (content) turns.push({ role: "user", content, ...(timestamp ? { timestamp } : {}) });
    }
    if (event.type === "assistant/message" && isRecord(event.data)) {
      const content = textOf(event.data.message);
      if (content) turns.push({ role: "assistant", content, ...(timestamp ? { timestamp } : {}) });
    }
  }
  return turns;
}

/** All completed user/assistant messages through the target turn. */
export function transcriptThroughTurn(events: readonly DshEvent[] | undefined, targetTurn: number): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let activeTurn: number | undefined;
  for (const event of events ?? []) {
    if (event.type === "turn/start" && isRecord(event.data) && typeof event.data.turn === "number") {
      activeTurn = event.data.turn;
      continue;
    }
    if (activeTurn === undefined || activeTurn > targetTurn) continue;
    const timestamp = typeof event.time === "number" ? new Date(event.time).toISOString() : undefined;
    if (event.type === "user/message" && isHumanMessage(event.data)) {
      const content = textOf(event.data);
      if (content) turns.push({ role: "user", content, ...(timestamp ? { timestamp } : {}) });
    }
    if (event.type === "assistant/message" && isRecord(event.data)) {
      const content = textOf(event.data.message);
      if (content) turns.push({ role: "assistant", content, ...(timestamp ? { timestamp } : {}) });
    }
  }
  return turns;
}
