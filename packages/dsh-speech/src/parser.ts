import { SPEECH_MAX_CHARS } from "./constants.js";

export interface SpeechPassage {
  text: string;
  transcript: string;
  start: number;
  end: number;
}

export type TaggedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "speech"; text: string; transcript: string };

export interface ParsedTaggedText {
  segments: TaggedTextSegment[];
  passage?: SpeechPassage;
}

const OPEN = "[[tts:text]]";
const CLOSE = "[[/tts:text]]";

function fencedRanges(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm;
  let open: { character: string; length: number; start: number } | undefined;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(input))) {
    const token = match[1];
    if (!token) continue;
    const suffix = match[2] ?? "";
    if (!open) {
      open = { character: token[0]!, length: token.length, start: match.index };
      continue;
    }
    // A closing fence must use the same marker character and be at least as
    // long as the opener. A shorter run is ordinary fenced-code content.
    if (open.character === token[0] && token.length >= open.length && /^[ \t]*$/.test(suffix)) {
      ranges.push([open.start, marker.lastIndex]);
      open = undefined;
    }
  }
  if (open) ranges.push([open.start, input.length]);
  return ranges;
}

function overlapsFence(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/** Collapse layout whitespace while retaining all spoken Unicode characters. */
export function normalizeSpeechText(value: string): string {
  return value.replace(/[\s\u00a0]+/gu, " ").trim();
}

function isValidPassage(text: string, raw: string): boolean {
  if (!text || raw.includes("[[") || raw.includes("]]")) return false;
  return Array.from(text).length <= SPEECH_MAX_CHARS;
}

/**
 * Parse one complete assistant prose block. A single valid pair is returned;
 * invalid or later pairs remain ordinary text. The caller may invoke this on
 * every streaming snapshot without maintaining a second buffer.
 */
export function parseTaggedText(input: string): ParsedTaggedText {
  const fences = fencedRanges(input);
  let cursor = 0;
  let passage: SpeechPassage | undefined;

  while (cursor < input.length) {
    const openAt = input.indexOf(OPEN, cursor);
    if (openAt < 0) break;
    const closeAt = input.indexOf(CLOSE, openAt + OPEN.length);
    if (closeAt < 0) break;
    const end = closeAt + CLOSE.length;
    const raw = input.slice(openAt + OPEN.length, closeAt);
    const normalized = normalizeSpeechText(raw);
    if (!passage && !overlapsFence(openAt, end, fences) && isValidPassage(normalized, raw)) {
      passage = { text: normalized, transcript: normalized, start: openAt, end };
      break;
    }
    cursor = end;
  }

  if (!passage) return { segments: [{ kind: "text", text: input }] };
  const segments: TaggedTextSegment[] = [];
  if (passage.start > 0) segments.push({ kind: "text", text: input.slice(0, passage.start) });
  segments.push({ kind: "speech", text: passage.text, transcript: passage.transcript });
  if (passage.end < input.length) segments.push({ kind: "text", text: input.slice(passage.end) });
  return { segments, passage };
}
