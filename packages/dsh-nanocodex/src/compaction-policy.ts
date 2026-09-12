import type { Context } from "@deepseek-ai/cordis";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import {
  createAssistantMessage,
  createUserMessage,
  type ContentBlock,
  type Message,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  type Session,
  type SessionEvent,
  type SessionSeq,
  isAppendSurfaceEvent,
} from "@deepseek-ai/dsh-session";
import type {
  CompactionContext,
  CompactionDecision,
  CompactionHistoryItem,
  CompactionItemIdentity,
  CompactionReplacementItem,
  HistoryItem,
} from "nanocodex/node";
import {
  buildHistoryProjection,
  plainText,
  type HistoryProjectionItem,
} from "./history.js";

export const COMPACTION_VISIBLE_ROUND_LIMIT = 5;
export const COMPACTION_VISIBLE_TOKEN_BUDGET = 4_000;

type CompactionPhase = CompactionContext["phase"];

interface SurfaceEntry {
  readonly surfaceIndex: number;
  readonly seq: SessionSeq;
  readonly event: SessionEvent;
  readonly message: Message;
  readonly turn: number | null;
}

interface ProjectionEntry {
  readonly surface: SurfaceEntry;
  readonly item: HistoryItem;
}

interface ContextUnit {
  readonly historyIndex: number;
  readonly supplied: CompactionHistoryItem;
  readonly projections: readonly ProjectionEntry[];
  readonly surfaceEntries: readonly SurfaceEntry[];
  readonly primary: SurfaceEntry | undefined;
  readonly kind:
    | "real-user"
    | "plugin-user"
    | "assistant-visible"
    | "tool"
    | "other";
  readonly turn: number | null;
}

interface ConversationRound {
  readonly key: string;
  readonly turn: number | null;
  readonly entries: readonly SurfaceEntry[];
  readonly visibleUnits: readonly ContextUnit[];
  readonly complete: boolean;
  readonly tokenEstimate: number;
}

export interface NanocodexCompactionSurfaceSegment {
  readonly start: SessionSeq;
  readonly end: SessionSeq;
  readonly shadowedSeqs: readonly SessionSeq[];
  readonly kind: "remove" | "replace";
  /** A replacement copy for a selected text message; absent means prune. */
  readonly message?: Message;
}

export interface NanocodexCompactionPlan {
  readonly operationId: string;
  readonly afterModelCallIndex: number;
  readonly phase: CompactionPhase;
  readonly trigger: CompactionContext["trigger"];
  readonly decision: CompactionDecision;
  /** DSH surface operations, in the surface order at the planning boundary. */
  readonly segments: readonly NanocodexCompactionSurfaceSegment[];
  /** All surface nodes removed or rewritten by the plan, in original order. */
  readonly shadowedSeqs: readonly SessionSeq[];
  readonly contextWindowTokens: number;
  readonly activeContextTokens: number;
}

interface TurnFacts {
  readonly eventTurn: ReadonlyMap<number, number | null>;
  readonly endReasons: ReadonlyMap<number, string>;
  readonly openTurns: ReadonlySet<number>;
}

interface SurfaceAction {
  readonly kind: "keep" | "remove" | "replace";
  readonly message?: Message;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageTextBlocks(message: Message): ContentBlock[] {
  return message.content.flatMap((block) =>
    block.type === "text" && block.text.length > 0
      ? [{ type: "text", text: block.text } as const]
      : [],
  );
}

function hasVisibleText(message: Message): boolean {
  return message.content.some(
    (block) => block.type === "text" && block.text.length > 0,
  );
}

function hasNonTextContent(message: Message): boolean {
  return message.content.some((block) => block.type !== "text");
}

function isModelOmittedAssistant(message: Message): boolean {
  return (
    message.role === "assistant" &&
    message.content.every((block) => block.type === "reasoning")
  );
}

function isToolResultMessage(message: Message): boolean {
  return (
    message.content.length === 1 && message.content[0]?.type === "tool-result"
  );
}

function isPlaceholder(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length === 0 &&
    message.source.kind === "plugin" &&
    message.source.plugin === "dsh-nanocodex"
  );
}

function isPrivateCheckpoint(message: Message): boolean {
  return message.role === "user" && isCompactCheckpointSource(message.source);
}

function isRealUser(message: Message): boolean {
  return message.role === "user" && message.source.kind === "user";
}

function isPluginUser(message: Message): boolean {
  return message.role === "user" && message.source.kind === "plugin";
}

function historyKind(item: Record<string, unknown>): string {
  if (item.type === "custom_tool_call") return "function_call";
  if (item.type === "custom_tool_call_output") return "function_call_output";
  return typeof item.type === "string" ? item.type : "";
}

function contentItemMatches(left: unknown, right: unknown): boolean {
  const a = asRecord(left);
  const b = asRecord(right);
  if (a === undefined || b === undefined || a.type !== b.type) return false;
  if (a.type === "input_text" || a.type === "output_text") {
    return typeof a.text === "string" && a.text === b.text;
  }
  if (a.type === "input_image") {
    return (
      typeof a.image_url === "string" &&
      a.image_url === b.image_url &&
      a.detail === b.detail
    );
  }
  if (a.type === "input_audio") {
    return typeof a.audio_url === "string" && a.audio_url === b.audio_url;
  }
  if (a.type === "encrypted_content") {
    return a.encrypted_content === b.encrypted_content;
  }
  return false;
}

function historyItemsMatch(left: unknown, right: unknown): boolean {
  const a = asRecord(left);
  const b = asRecord(right);
  if (a === undefined || b === undefined || historyKind(a) !== historyKind(b)) {
    return false;
  }
  switch (historyKind(a)) {
    case "message": {
      if (
        a.role !== b.role ||
        !Array.isArray(a.content) ||
        !Array.isArray(b.content)
      )
        return false;
      const aContent = a.content;
      const bContent = b.content;
      return (
        aContent.length === bContent.length &&
        aContent.every((part, index) =>
          contentItemMatches(part, bContent[index]),
        )
      );
    }
    case "function_call":
      return (
        a.name === b.name &&
        a.arguments === b.arguments &&
        a.call_id === b.call_id
      );
    case "function_call_output":
      return a.call_id === b.call_id && toolOutputMatches(a.output, b.output);
    case "compaction":
      return a.encrypted_content === b.encrypted_content;
    default:
      return false;
  }
}

function toolOutputMatches(left: unknown, right: unknown): boolean {
  if (typeof left === "string" || typeof right === "string")
    return left === right;
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length
  )
    return false;
  return left.every((part, index) => contentItemMatches(part, right[index]));
}

function messageHistoryMatches(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return historyItemsMatch(left, right);
}

function suppliedOrigin(item: CompactionHistoryItem): CompactionItemIdentity {
  return item.origin;
}

function turnFacts(session: Session): TurnFacts {
  const eventTurn = new Map<number, number | null>();
  const endReasons = new Map<number, string>();
  const openTurns = new Set<number>();
  let active: number | null = null;
  for (const event of session.snapshotEvents()) {
    eventTurn.set(event.seq, active);
    if (event.type === "turn/start") {
      active = event.data.turn;
      openTurns.add(active);
      eventTurn.set(event.seq, active);
    } else if (event.type === "turn/end") {
      endReasons.set(event.data.turn, event.data.reason.kind);
      openTurns.delete(event.data.turn);
      eventTurn.set(event.seq, event.data.turn);
      active = null;
    }
  }
  return { eventTurn, endReasons, openTurns };
}

function eventTurnFor(
  event: SessionEvent,
  facts: TurnFacts,
  eventsBySeq: ReadonlyMap<number, SessionEvent>,
): number | null {
  const data = asRecord(event.data);
  const explicit = data?.turn;
  if (typeof explicit === "number") return explicit;
  const sources =
    "sourceEventSeqs" in event && Array.isArray(event.sourceEventSeqs)
      ? event.sourceEventSeqs
      : [];
  for (const source of sources) {
    const sourceEvent = eventsBySeq.get(source);
    if (sourceEvent !== undefined) {
      const turn = eventTurnFor(sourceEvent, facts, eventsBySeq);
      if (turn !== null) return turn;
    }
  }
  return facts.eventTurn.get(event.seq) ?? null;
}

function surfaceEntries(session: Session): readonly SurfaceEntry[] {
  const nodes = [...session.surface.nodes];
  const messages = session.deriveMessages();
  if (nodes.length !== messages.length) {
    throw new Error("Nanocodex compaction cannot map a mismatched DSH surface");
  }
  const facts = turnFacts(session);
  const eventsBySeq = new Map(
    session
      .snapshotEvents()
      .map((event) => [Number(event.seq), event] as const),
  );
  return nodes.map((seq, surfaceIndex) => {
    const event = session.eventAt(seq);
    const message = messages[surfaceIndex];
    if (event === undefined || message === undefined) {
      throw new Error("Nanocodex compaction surface projection is incomplete");
    }
    return {
      surfaceIndex,
      seq,
      event,
      message,
      turn: eventTurnFor(event, facts, eventsBySeq),
    };
  });
}

function pluginGroupEnd(
  projections: readonly ProjectionEntry[],
  start: number,
): number {
  let end = start + 1;
  while (
    end < projections.length &&
    isPluginUser(projections[end]!.surface.message) &&
    asRecord(projections[end]!.item)?.type === "message" &&
    asRecord(projections[end]!.item)?.role === "user"
  ) {
    end += 1;
  }
  return end;
}

function mergedUserItem(
  entries: readonly ProjectionEntry[],
): Record<string, unknown> | undefined {
  const first = entries[0];
  if (
    first === undefined ||
    first.item.type !== "message" ||
    first.item.role !== "user" ||
    !isRealUser(first.surface.message)
  ) {
    return undefined;
  }
  const pluginText = entries
    .slice(1)
    .map((entry) => plainText([entry.surface.message]))
    .filter(Boolean)
    .join("\n\n");
  if (!pluginText) return undefined;
  return {
    ...first.item,
    content: [...first.item.content, { type: "input_text", text: pluginText }],
  };
}

function unitKind(
  projections: readonly ProjectionEntry[],
): ContextUnit["kind"] {
  const first = projections[0];
  if (first === undefined) return "other";
  const { item, surface } = first;
  if (item.type === "message" && item.role === "user") {
    if (isRealUser(surface.message)) return "real-user";
    if (isPluginUser(surface.message)) return "plugin-user";
  }
  if (
    item.type === "message" &&
    item.role === "assistant" &&
    hasVisibleText(surface.message)
  )
    return "assistant-visible";
  if (
    item.type === "function_call" ||
    item.type === "function_call_output" ||
    item.type === "custom_tool_call" ||
    item.type === "custom_tool_call_output" ||
    isToolResultMessage(surface.message)
  ) {
    return "tool";
  }
  return "other";
}

function buildProjectionUnits(
  session: Session,
  history: readonly CompactionHistoryItem[],
  projectionItems: readonly HistoryProjectionItem[],
): {
  readonly surfaces: readonly SurfaceEntry[];
  readonly units: readonly ContextUnit[];
  readonly historyBySurfaceIndex: ReadonlyMap<number, readonly number[]>;
  readonly pendingSurfaceIndices: ReadonlySet<number>;
} {
  const surfaces = surfaceEntries(session);
  const byMessageId = new Map(
    surfaces.map((entry) => [String(entry.message.id), entry] as const),
  );
  const projections = projectionItems.flatMap((entry) => {
    const surface = byMessageId.get(String(entry.message.id));
    return surface === undefined ? [] : [{ surface, item: entry.item }];
  });
  const units: ContextUnit[] = [];
  const historyBySurfaceIndex = new Map<number, number[]>();
  const facts = turnFacts(session);
  let cursor = 0;
  for (const [historyIndex, supplied] of history.entries()) {
    const candidate = projections[cursor];
    if (candidate === undefined) continue;
    const groupEnd =
      candidate.item.type === "message" &&
      candidate.item.role === "user" &&
      isRealUser(candidate.surface.message)
        ? pluginGroupEnd(projections, cursor)
        : cursor + 1;
    const candidateMatches = historyItemsMatch(candidate.item, supplied.item);
    const grouped = projections.slice(cursor, groupEnd);
    const merged = mergedUserItem(grouped);
    const mergedMatches =
      merged !== undefined && messageHistoryMatches(merged, supplied.item);
    const group = mergedMatches ? grouped : candidateMatches ? [candidate] : [];
    if (group.length === 0) continue;
    const surfaceEntriesForUnit = [
      ...new Map(
        group.map(
          (entry) => [entry.surface.surfaceIndex, entry.surface] as const,
        ),
      ).values(),
    ];
    const unit: ContextUnit = {
      historyIndex,
      supplied,
      projections: group,
      surfaceEntries: surfaceEntriesForUnit,
      primary: surfaceEntriesForUnit[0],
      kind: unitKind(group),
      turn: surfaceEntriesForUnit[0]?.turn ?? null,
    };
    units.push(unit);
    for (const entry of surfaceEntriesForUnit) {
      const indexes = historyBySurfaceIndex.get(entry.surfaceIndex) ?? [];
      indexes.push(historyIndex);
      historyBySurfaceIndex.set(entry.surfaceIndex, indexes);
    }
    // A separately represented plugin input is its own accepted history item.
    // Only advance over the whole projection group when the engine supplied a
    // merged real-user item; otherwise the next history item must consume the
    // next projection entry rather than silently orphaning plugin context.
    cursor = mergedMatches ? groupEnd : cursor + 1;
  }
  const pendingSurfaceIndices = new Set(
    projections.slice(cursor).flatMap((entry) => {
      const turn = entry.surface.turn;
      return turn !== null && facts.openTurns.has(turn)
        ? [entry.surface.surfaceIndex]
        : [];
    }),
  );
  // The current DSH step can also contain supplementary/plugin context that
  // has not entered Nanocodex's public history yet. It is still part of the
  // unfinished surface and must survive this pre-turn operation. Treat every
  // otherwise-unmapped node in an open turn as pending; closed-turn nodes must
  // continue to fail the provenance check below.
  for (const surface of surfaces) {
    if (
      !historyBySurfaceIndex.has(surface.surfaceIndex) &&
      surface.turn !== null &&
      facts.openTurns.has(surface.turn)
    ) {
      pendingSurfaceIndices.add(surface.surfaceIndex);
    }
  }
  if (
    cursor !== projections.length &&
    pendingSurfaceIndices.size !== projections.length - cursor
  ) {
    throw new Error(
      "Nanocodex compaction context history does not match the active DSH surface",
    );
  }
  return {
    surfaces,
    units,
    historyBySurfaceIndex,
    pendingSurfaceIndices,
  };
}

function makeVisibleHistoryItem(message: Message): HistoryItem | undefined {
  const content = messageTextBlocks(message);
  if (content.length === 0) return undefined;
  return {
    type: "message",
    role: message.role === "assistant" ? "assistant" : "user",
    content: content.map((block) =>
      message.role === "assistant"
        ? { type: "output_text", text: block.type === "text" ? block.text : "" }
        : { type: "input_text", text: block.type === "text" ? block.text : "" },
    ),
    status: "completed",
  };
}

function makeVisibleDshMessage(message: Message): Message | undefined {
  const textBlocks = message.content.flatMap((block) =>
    block.type === "text" && block.text.length > 0
      ? [{ type: "text", text: block.text } as const]
      : [],
  );
  if (textBlocks.length === 0) return undefined;
  if (message.role === "assistant") {
    return createAssistantMessage({
      content: textBlocks,
      source:
        message.source.kind === "model"
          ? { provider: message.source.provider, model: message.source.model }
          : { provider: "nanocodex", model: "compaction" },
    });
  }
  return createUserMessage({ content: textBlocks, source: message.source });
}

function visibleUnitMessage(unit: ContextUnit): Message | undefined {
  const primary = unit.primary;
  return primary === undefined
    ? undefined
    : makeVisibleDshMessage(primary.message);
}

function isPureVisibleUnit(unit: ContextUnit): boolean {
  const primary = unit.primary;
  return (
    primary !== undefined &&
    hasVisibleText(primary.message) &&
    !hasNonTextContent(primary.message) &&
    unit.surfaceEntries.length === 1 &&
    unit.projections.length === 1 &&
    isAppendSurfaceEvent(primary.event)
  );
}

function roundKey(turn: number | null, firstSurfaceIndex: number): string {
  return turn === null ? `implicit:${firstSurfaceIndex}` : `turn:${turn}`;
}

function visibleUnitsFor(
  entries: readonly SurfaceEntry[],
  unitsBySurface: ReadonlyMap<number, readonly ContextUnit[]>,
): ContextUnit[] {
  const units: ContextUnit[] = [];
  const seenSurfaces = new Set<number>();
  for (const entry of entries) {
    for (const unit of unitsBySurface.get(entry.surfaceIndex) ?? []) {
      if (unit.kind !== "real-user" && unit.kind !== "assistant-visible") {
        continue;
      }
      const primaryIndex = unit.primary?.surfaceIndex;
      if (primaryIndex === undefined || seenSurfaces.has(primaryIndex)) {
        continue;
      }
      seenSurfaces.add(primaryIndex);
      units.push(unit);
    }
  }
  return units;
}

function fallbackRounds(
  surfaces: readonly SurfaceEntry[],
  unitsBySurface: ReadonlyMap<number, readonly ContextUnit[]>,
  tokenMeter: Context["tokenMeter"],
): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  let entries: SurfaceEntry[] = [];
  let sawAssistant = false;
  const finish = () => {
    if (entries.length === 0) return;
    const visibleUnits = visibleUnitsFor(entries, unitsBySurface);
    const hasRealUser = visibleUnits.some((unit) => unit.kind === "real-user");
    const hasAssistantVisible = visibleUnits.some(
      (unit) => unit.kind === "assistant-visible",
    );
    const tokenEstimate = visibleUnits.reduce((total, unit) => {
      const message = visibleUnitMessage(unit);
      return message === undefined
        ? total
        : total + tokenMeter.estimateMessage(message);
    }, 0);
    rounds.push({
      key: roundKey(null, entries[0]!.surfaceIndex),
      turn: null,
      entries: [...entries],
      visibleUnits,
      complete: hasRealUser && hasAssistantVisible,
      tokenEstimate,
    });
    entries = [];
    sawAssistant = false;
  };
  for (const entry of surfaces) {
    if (isPrivateCheckpoint(entry.message) || isPlaceholder(entry.message))
      continue;
    const isUser = isRealUser(entry.message);
    const isAssistant =
      entry.message.role === "assistant" && hasVisibleText(entry.message);
    if (isUser && sawAssistant) finish();
    entries.push(entry);
    if (isAssistant) sawAssistant = true;
  }
  finish();
  return rounds;
}

function roundsFor(
  surfaces: readonly SurfaceEntry[],
  unitsBySurface: ReadonlyMap<number, readonly ContextUnit[]>,
  facts: TurnFacts,
  tokenMeter: Context["tokenMeter"],
): ConversationRound[] {
  const withTurn = surfaces.filter((entry) => entry.turn !== null);
  if (withTurn.length === 0) {
    return fallbackRounds(surfaces, unitsBySurface, tokenMeter);
  }
  const grouped = new Map<number, SurfaceEntry[]>();
  for (const entry of surfaces) {
    if (
      entry.turn === null ||
      isPrivateCheckpoint(entry.message) ||
      isPlaceholder(entry.message)
    )
      continue;
    const entries = grouped.get(entry.turn) ?? [];
    entries.push(entry);
    grouped.set(entry.turn, entries);
  }
  const turnedRounds = [...grouped.entries()].map(([turn, entries]) => {
    const visibleUnits = visibleUnitsFor(entries, unitsBySurface);
    const hasRealUser = visibleUnits.some((unit) => unit.kind === "real-user");
    const hasAssistantVisible = visibleUnits.some(
      (unit) => unit.kind === "assistant-visible",
    );
    const tokenEstimate = visibleUnits.reduce((total, unit) => {
      const message = visibleUnitMessage(unit);
      return message === undefined
        ? total
        : total + tokenMeter.estimateMessage(message);
    }, 0);
    return {
      key: roundKey(turn, entries[0]!.surfaceIndex),
      turn,
      entries,
      visibleUnits,
      complete:
        hasRealUser &&
        hasAssistantVisible &&
        facts.endReasons.get(turn) === "completed" &&
        !facts.openTurns.has(turn),
      tokenEstimate,
    };
  });
  const unturnedRounds = fallbackRounds(
    surfaces.filter((entry) => entry.turn === null),
    unitsBySurface,
    tokenMeter,
  );
  return [...turnedRounds, ...unturnedRounds].sort(
    (left, right) =>
      left.entries[0]!.surfaceIndex - right.entries[0]!.surfaceIndex,
  );
}

function selectedRounds(
  rounds: readonly ConversationRound[],
): ReadonlySet<string> {
  const selected = new Set<string>();
  let count = 0;
  let used = 0;
  let started = false;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!;
    if (!round.complete) {
      if (started) break;
      continue;
    }
    started = true;
    if (
      count > 0 &&
      (count >= COMPACTION_VISIBLE_ROUND_LIMIT ||
        used + round.tokenEstimate > COMPACTION_VISIBLE_TOKEN_BUDGET)
    ) {
      break;
    }
    selected.add(round.key);
    count += 1;
    used += round.tokenEstimate;
  }
  return selected;
}

function actionForSurface(
  surface: SurfaceEntry,
  units: readonly ContextUnit[],
  pendingSurfaceIndices: ReadonlySet<number>,
  selected: ReadonlySet<string>,
  roundsByTurn: ReadonlyMap<number, ConversationRound>,
  implicitRoundBySurface: ReadonlyMap<number, ConversationRound>,
): SurfaceAction {
  if (units.length === 0 && pendingSurfaceIndices.has(surface.surfaceIndex)) {
    return { kind: "keep" };
  }
  const primary =
    units.find((unit) => unit.primary?.surfaceIndex === surface.surfaceIndex) ??
    units[0];
  const round =
    surface.turn === null
      ? implicitRoundBySurface.get(surface.surfaceIndex)
      : roundsByTurn.get(surface.turn);
  if (round !== undefined && !round.complete && round.entries.length > 0) {
    return { kind: "keep" };
  }
  if (isPrivateCheckpoint(surface.message) || isPlaceholder(surface.message)) {
    return { kind: "remove" };
  }
  // Supplementary plugin context is folded into a real user input for the
  // engine request, but it is not a retained visible conversational round.
  // Historical plugin nodes are pruned even when their real-user group is
  // selected. Active-turn plugin context is kept by the branch above.
  if (isPluginUser(surface.message)) return { kind: "remove" };
  if (round !== undefined && selected.has(round.key)) {
    if (
      (primary?.kind === "real-user" ||
        primary?.kind === "assistant-visible") &&
      hasVisibleText(surface.message)
    ) {
      if (primary !== undefined && isPureVisibleUnit(primary))
        return { kind: "keep" };
      const message = makeVisibleDshMessage(surface.message);
      return message === undefined
        ? { kind: "remove" }
        : { kind: "replace", message };
    }
  }
  return { kind: "remove" };
}

/**
 * DSH-owned history is identified by the exact surface projection above. Any
 * unmapped message/compaction item is engine-owned context; its text is never
 * inspected, so quoted instruction or summary markers stay ordinary DSH data.
 */
function isEngineOwnedHistoryItem(
  item: CompactionHistoryItem,
  unit: ContextUnit | undefined,
): boolean {
  if (unit !== undefined) return false;
  return (
    item.item.type === "compaction" ||
    (item.item.type === "message" &&
      (item.item.role === "developer" || item.item.role === "user"))
  );
}

function toolCallIds(message: Message): readonly string[] {
  return message.content.flatMap((block) =>
    block.type === "tool-call" ? [String(block.id)] : [],
  );
}

function resultCallId(message: Message): string | undefined {
  const block = message.content[0];
  return block?.type === "tool-result" ? String(block.toolCallId) : undefined;
}

function toolSpanEnd(surfaces: readonly SurfaceEntry[], start: number): number {
  const calls = new Set(toolCallIds(surfaces[start]!.message));
  if (calls.size === 0) return start;
  const found = new Set<string>();
  let end = start;
  for (let index = start + 1; index < surfaces.length; index += 1) {
    const result = resultCallId(surfaces[index]!.message);
    if (result === undefined) {
      if (found.size === calls.size) break;
      throw new Error(
        "Nanocodex compaction cannot split an active tool exchange",
      );
    }
    if (!calls.has(result)) {
      if (found.size === calls.size) break;
      throw new Error("Nanocodex compaction found an unrelated tool result");
    }
    found.add(result);
    end = index;
    if (found.size === calls.size) break;
  }
  if (found.size !== calls.size) {
    throw new Error("Nanocodex compaction found an incomplete tool exchange");
  }
  return end;
}

function emptySurfaceMessage(): UserMessage {
  return createUserMessage({
    content: [],
    source: { kind: "plugin", plugin: "dsh-nanocodex" },
  });
}

function segmentize(
  surfaces: readonly SurfaceEntry[],
  actions: ReadonlyMap<number, SurfaceAction>,
): NanocodexCompactionSurfaceSegment[] {
  const segments: NanocodexCompactionSurfaceSegment[] = [];
  let index = 0;
  while (index < surfaces.length) {
    const action = actions.get(index) ?? { kind: "remove" as const };
    const entry = surfaces[index]!;
    const toolEnd =
      entry.message.role === "assistant" &&
      toolCallIds(entry.message).length > 0
        ? toolSpanEnd(surfaces, index)
        : index;
    let end = toolEnd;
    if (action.kind === "remove" && toolEnd === index) {
      while (
        end + 1 < surfaces.length &&
        (actions.get(end + 1)?.kind ?? "remove") === "remove" &&
        !(
          surfaces[end + 1]!.message.role === "assistant" &&
          toolCallIds(surfaces[end + 1]!.message).length > 0
        )
      ) {
        end += 1;
      }
    }
    if (action.kind === "keep") {
      index = end + 1;
      continue;
    }
    const shadowed = surfaces
      .slice(index, end + 1)
      .map((candidate) => candidate.seq);
    segments.push({
      start: shadowed[0]!,
      end: shadowed.at(-1)!,
      shadowedSeqs: shadowed,
      kind: action.kind === "replace" ? "replace" : "remove",
      ...(action.message === undefined ? {} : { message: action.message }),
    });
    index = end + 1;
  }
  return segments;
}

export async function buildNanocodexCompactionPlan(
  session: Session,
  context: CompactionContext,
  host: Context,
  signal: AbortSignal,
): Promise<NanocodexCompactionPlan> {
  signal.throwIfAborted();
  const projection = await buildHistoryProjection(
    session.deriveMessages(),
    { attachments: host.attachments },
    signal,
  );
  const mapped = buildProjectionUnits(
    session,
    context.history,
    projection.items,
  );
  const facts = turnFacts(session);
  const unitsBySurface = new Map<number, ContextUnit[]>();
  for (const unit of mapped.units) {
    for (const entry of unit.surfaceEntries) {
      const units = unitsBySurface.get(entry.surfaceIndex) ?? [];
      units.push(unit);
      unitsBySurface.set(entry.surfaceIndex, units);
    }
  }
  for (const surface of mapped.surfaces) {
    if (
      !unitsBySurface.has(surface.surfaceIndex) &&
      !isPrivateCheckpoint(surface.message) &&
      !isPlaceholder(surface.message) &&
      !isModelOmittedAssistant(surface.message) &&
      !mapped.pendingSurfaceIndices.has(surface.surfaceIndex)
    ) {
      throw new Error(
        "Nanocodex compaction could not associate a DSH surface node with its accepted history",
      );
    }
  }
  const rounds = roundsFor(
    mapped.surfaces,
    unitsBySurface,
    facts,
    host.tokenMeter,
  );
  const selected = selectedRounds(rounds);
  const roundsByTurn = new Map(
    rounds.flatMap((round) =>
      round.turn === null ? [] : [[round.turn, round] as const],
    ),
  );
  const implicitRoundBySurface = new Map<number, ConversationRound>();
  for (const round of rounds) {
    if (round.turn === null) {
      for (const entry of round.entries)
        implicitRoundBySurface.set(entry.surfaceIndex, round);
    }
  }
  const actions = new Map<number, SurfaceAction>();
  for (const surface of mapped.surfaces) {
    const units = unitsBySurface.get(surface.surfaceIndex) ?? [];
    actions.set(
      surface.surfaceIndex,
      actionForSurface(
        surface,
        units,
        mapped.pendingSurfaceIndices,
        selected,
        roundsByTurn,
        implicitRoundBySurface,
      ),
    );
  }
  const segments = segmentize(mapped.surfaces, actions);
  const historyByIndex = new Map(
    mapped.units.map((unit) => [unit.historyIndex, unit] as const),
  );
  const selectedIndices = new Set<number>();
  for (const round of rounds) {
    if (!selected.has(round.key)) continue;
    for (const unit of round.visibleUnits)
      selectedIndices.add(unit.historyIndex);
  }
  const unfinishedIndices = new Set<number>();
  for (const round of rounds) {
    if (round.complete) continue;
    for (const entry of round.entries) {
      for (const unit of unitsBySurface.get(entry.surfaceIndex) ?? []) {
        unfinishedIndices.add(unit.historyIndex);
      }
    }
  }
  const decisionHistory: CompactionReplacementItem[] = [
    { kind: "summary", text: context.summary },
  ];
  const replacementByHistoryIndex = new Map<number, Message>();
  for (const segment of segments) {
    if (segment.kind !== "replace" || segment.message === undefined) continue;
    const primaryUnit = (
      mapped.historyBySurfaceIndex.get(
        mapped.surfaces.find((entry) => entry.seq === segment.start)
          ?.surfaceIndex ?? -1,
      ) ?? []
    )
      .map((index) => historyByIndex.get(index))
      .find(
        (unit) =>
          unit?.kind === "real-user" || unit?.kind === "assistant-visible",
      );
    if (primaryUnit !== undefined)
      replacementByHistoryIndex.set(primaryUnit.historyIndex, segment.message);
  }

  for (const item of context.history) {
    signal.throwIfAborted();
    const unit = historyByIndex.get(item.origin.index);
    if (unit === undefined) {
      if (!isEngineOwnedHistoryItem(item, unit)) {
        decisionHistory.push({
          kind: "original",
          origin: suppliedOrigin(item),
        });
      }
      continue;
    }
    if (unfinishedIndices.has(unit.historyIndex)) {
      decisionHistory.push({ kind: "original", origin: suppliedOrigin(item) });
      continue;
    }
    if (selectedIndices.has(unit.historyIndex)) {
      const replacement = replacementByHistoryIndex.get(unit.historyIndex);
      if (replacement !== undefined && !isPureVisibleUnit(unit)) {
        const newItem = makeVisibleHistoryItem(replacement);
        if (newItem !== undefined)
          decisionHistory.push({ kind: "item", item: newItem });
      } else if (
        unit.kind === "real-user" ||
        unit.kind === "assistant-visible"
      ) {
        decisionHistory.push({
          kind: "original",
          origin: suppliedOrigin(item),
        });
      }
    }
  }

  const decision: CompactionDecision = {
    operation_id: context.operation_id,
    history: decisionHistory,
  };
  const shadowedSeqs = segments.flatMap((segment) => segment.shadowedSeqs);
  const unique = [...new Set(shadowedSeqs)];
  if (unique.length !== shadowedSeqs.length) {
    throw new Error(
      "Nanocodex compaction plan contains duplicate surface nodes",
    );
  }
  return {
    operationId: context.operation_id,
    afterModelCallIndex: context.after_model_call_index,
    phase: context.phase,
    trigger: context.trigger,
    decision,
    segments,
    shadowedSeqs,
    contextWindowTokens: context.context_window_tokens,
    activeContextTokens: context.active_context_tokens,
  };
}

export function compactionPlaceholderMessage(): UserMessage {
  return emptySurfaceMessage();
}
