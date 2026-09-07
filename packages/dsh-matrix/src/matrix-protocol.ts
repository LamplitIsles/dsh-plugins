import {
  DEDUPE_LIMIT,
  MAX_PROMPT_CHARS,
  MAX_PROVENANCE_CHARS,
  PACKAGE_NAME,
  type MatrixSettings
} from "./constants.js";

export interface MatrixEventLike {
  getType?: () => string;
  getRoomId?: () => string | undefined;
  getSender?: () => string | undefined;
  getId?: () => string | undefined;
  getContent?: () => Record<string, unknown>;
  getWireContent?: () => Record<string, unknown>;
  getOriginalContent?: () => Record<string, unknown>;
  getUnsigned?: () => Record<string, unknown>;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatrixTimelineData {
  timeline?: "live" | "back-paginate" | "forward-paginate" | string;
  liveEvent?: boolean;
  [key: string]: unknown;
}

export interface MatrixRoomLike {
  getMember?: (userId: string) => unknown | null | undefined;
  getTimeline?: () => readonly unknown[];
  timeline?: readonly unknown[];
  getLiveTimeline?: () => { getEvents?: () => readonly unknown[] };
  getJoinedMembers?: () => readonly unknown[];
  getMembers?: () => readonly unknown[];
}

export interface MatrixClientLike {
  startClient?: (options?: Record<string, unknown>) => void | Promise<void>;
  stopClient?: () => void | Promise<void>;
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
  sendMessage?: (roomId: string, content: Record<string, unknown>) => Promise<unknown>;
  sendEvent?: (roomId: string, type: string, content: Record<string, unknown>) => Promise<unknown>;
  uploadContent?: (data: Uint8Array, options?: {
    name?: string;
    type?: string;
    abortController?: AbortController;
  }) => Promise<{ content_uri?: unknown }>;
  getRoom?: (roomId: string) => MatrixRoomLike | null | undefined;
  /** Matrix /messages, used only by the bounded recent-message tool. */
  createMessagesRequest?: (roomId: string, fromToken: string | null, limit: number, direction: "b") => Promise<{
    chunk: readonly MatrixEventLike[];
    end?: string;
  }>;
  fetchRoomEvent?: (roomId: string, eventId: string, signal?: AbortSignal) => Promise<MatrixEventLike>;
  getUserId?: () => string | undefined;
}

export interface AdmittedMatrixMessage {
  eventId: string;
  roomId: string;
  sender: string;
  /** Current local room label captured alongside the stable Matrix sender ID. */
  displayName: string;
  text: string;
  source: MatrixProvenance;
  /** Whether this event is allowed to open a Matrix-initiated turn. */
  trigger?: boolean;
  /** The event this message replied to, when Matrix supplied a reply relation. */
  replyToEventId?: string;
}

/** One bounded record retained in the in-memory allowed-room context buffer. */
export interface MatrixContextRecord {
  eventId: string;
  roomId: string;
  sender: string;
  /** Current room display label; the sender ID remains the stable identity. */
  displayName: string;
  text: string;
}

/** Bounded routing provenance retained by the bridge, never on the user message or in prompt metadata. */
export interface MatrixProvenance {
  kind: "plugin";
  plugin: typeof PACKAGE_NAME;
  roomId: string;
  sender: string;
  eventId: string;
  /** Bounded records supplied alongside the composite prompt for Host attribution. */
  context?: readonly MatrixContextRecord[];
  /** Stable identity of the record that opened this Matrix-initiated turn. */
  triggerEventId?: string;
  /** Bounded relation target used for reply verification, when present. */
  replyToEventId?: string;
}

function call<T>(event: MatrixEventLike, method: keyof MatrixEventLike, fallback: T): T {
  const value = event[method];
  if (typeof value === "function") {
    try {
      const result = (value as () => unknown)();
      return (result as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function matrixEventType(event: MatrixEventLike): string | undefined {
  return call(event, "getType", (event.event?.type as string | undefined) ?? (event.type as string | undefined));
}

export function matrixEventRoomId(event: MatrixEventLike): string | undefined {
  return call(event, "getRoomId", (event.event?.room_id as string | undefined) ?? (event.roomId as string | undefined) ?? (event.room_id as string | undefined));
}

export function matrixEventSender(event: MatrixEventLike): string | undefined {
  return call(event, "getSender", (event.event?.sender as string | undefined) ?? (event.sender as string | undefined));
}

export function matrixEventId(event: MatrixEventLike): string | undefined {
  return call(event, "getId", (event.event?.event_id as string | undefined) ?? (event.eventId as string | undefined) ?? (event.event_id as string | undefined));
}

export function matrixEventContent(event: MatrixEventLike): Record<string, unknown> {
  const content = call(event, "getContent", undefined as Record<string, unknown> | undefined);
  if (content && typeof content === "object") return content;
  const original = call(event, "getOriginalContent", undefined as Record<string, unknown> | undefined);
  if (original && typeof original === "object") return original;
  const wire = call(event, "getWireContent", undefined as Record<string, unknown> | undefined);
  if (wire && typeof wire === "object") return wire;
  const fallback = event.event?.content;
  if (fallback && typeof fallback === "object") return fallback as Record<string, unknown>;
  const wireFallback = event.content;
  return wireFallback && typeof wireFallback === "object" ? wireFallback as Record<string, unknown> : {};
}

function boundedMemberLabel(value: unknown, userId: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  // Matrix SDK `name` is already disambiguated, but falls back to the ID when
  // no display name is known. That fallback is useful for records, not a
  // separate label trigger.
  return label && label !== userId.trim() ? label.slice(0, MAX_PROVENANCE_CHARS).trim() || undefined : undefined;
}

/** Read one current display label from already-loaded local room state. */
export function matrixMemberDisplayName(member: unknown, userId: string): string | undefined {
  if (!member || typeof member !== "object") return undefined;
  const value = member as { name?: unknown; displayName?: unknown; rawDisplayName?: unknown };
  return boundedMemberLabel(value.name, userId)
    ?? boundedMemberLabel(value.displayName, userId)
    ?? boundedMemberLabel(value.rawDisplayName, userId);
}

function localRoomMember(client: MatrixClientLike, roomId: string, userId: string): unknown {
  let room: MatrixRoomLike | null | undefined;
  try { room = client.getRoom?.(roomId); } catch { return undefined; }
  if (!room) return undefined;
  try {
    const direct = room.getMember?.(userId);
    if (direct) return direct;
  } catch { /* use other local member accessors */ }
  for (const accessor of [room.getJoinedMembers, room.getMembers]) {
    let members: readonly unknown[] | undefined;
    try { members = accessor?.call(room); } catch { continue; }
    if (!Array.isArray(members)) continue;
    const member = members.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as { userId?: unknown; user_id?: unknown; getUserId?: () => unknown };
      let memberId: unknown = value.userId ?? value.user_id;
      try { memberId = value.getUserId?.() ?? memberId; } catch { /* use fields */ }
      return memberId === userId;
    });
    if (member) return member;
  }
  return undefined;
}

/** Read a current room display label without making a profile or homeserver request. */
export function readLocalRoomDisplayName(
  client: MatrixClientLike | undefined,
  roomId: string,
  userId: string
): string | undefined {
  if (!client?.getRoom || !roomId.trim() || !userId.trim()) return undefined;
  return matrixMemberDisplayName(localRoomMember(client, roomId, userId), userId);
}

function relatesTo(content: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = content["m.relates_to"];
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isReplyRelation(relation: Record<string, unknown> | undefined): string | undefined {
  const reply = relation?.["m.in_reply_to"];
  if (!reply || typeof reply !== "object") return undefined;
  const eventId = (reply as { event_id?: unknown }).event_id;
  return typeof eventId === "string" && eventId ? eventId : undefined;
}

function hasMention(content: Record<string, unknown>, userId: string): boolean {
  const mentions = content["m.mentions"];
  if (!mentions || typeof mentions !== "object") return false;
  const userIds = (mentions as { user_ids?: unknown }).user_ids;
  return Array.isArray(userIds) && userIds.some((candidate) => candidate === userId);
}

function relationIsUnsupported(content: Record<string, unknown>): boolean {
  const relation = relatesTo(content);
  if (!relation) return false;
  const relationType = relation.rel_type;
  if (relationType === "m.replace" || relationType === "m.thread") return true;
  // Only a bare in-reply-to relation is supported by the bridge. References,
  // annotations, and unknown relation forms are not conversational triggers.
  if (relationType !== undefined && relationType !== "") return true;
  return Object.hasOwn(relation, "event_id") && !Object.hasOwn(relation, "m.in_reply_to");
}

function stripReplyFallback(text: string): string {
  let result = text.replace(/^\s*<mx-reply>[\s\S]*?<\/mx-reply>\s*/i, "");
  // Older Matrix clients put a plain-text quote before the actual body. Remove
  // only a contiguous leading quote block so ordinary prose beginning with `>`
  // is not unexpectedly rewritten later in the message.
  const lines = result.split(/\r?\n/);
  while (lines.length > 0 && /^\s*>/.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeEnvelopeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** Remove reply fallback markup and the configured bot mention while retaining human text. */
export function cleanMatrixPrompt(text: string, userId: string): string {
  let result = stripReplyFallback(text).trim();
  const localpart = userId.startsWith("@") ? userId.slice(1).split(":", 1)[0] : userId.split(":", 1)[0];
  const mentionForms = [userId, userId.startsWith("@") ? userId.slice(1) : `@${userId}`, `@${localpart}`]
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .map(escapeRegExp);
  if (mentionForms.length > 0) {
    result = result.replace(new RegExp(`(?:^|[\\s])(?:${mentionForms.join("|")})(?=$|[\\s,:;.!?])`, "gi"), " ");
  }
  result = result.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  return result.slice(0, MAX_PROMPT_CHARS).trim();
}

/**
 * Render one deterministic model-facing transcript. Matrix records are quoted
 * data: the envelope is authored by the plugin and explicitly separates that
 * data from instructions supplied by the room.
 */
export function renderMatrixContextPrompt(
  records: readonly MatrixContextRecord[],
  triggerEventId: string
): string {
  const lines = [
    "[dsh-matrix room context]",
    `Reply trigger event: ${triggerEventId}`,
  ];
  records.forEach((record, index) => {
    const trigger = record.eventId === triggerEventId ? " trigger=true" : "";
    const eventId = escapeEnvelopeAttribute(record.eventId);
    const sender = escapeEnvelopeAttribute(record.sender);
    const displayName = escapeEnvelopeAttribute(record.displayName.slice(0, MAX_PROVENANCE_CHARS));
    lines.push(`<record index="${index + 1}" event_id="${eventId}" sender="${sender}"${trigger} display_name="${displayName}">`);
    lines.push(`Speaker: ${displayName} (${sender})`);
    lines.push(record.text);
    lines.push("</record>");
  });
  lines.push("[/dsh-matrix room context]");
  return lines.join("\n");
}

function roomTimelineEvents(room: MatrixRoomLike | null | undefined): readonly unknown[] {
  if (!room) return [];
  try {
    const timeline = room.getTimeline?.();
    if (Array.isArray(timeline)) return timeline;
  } catch {
    // Fall through to the SDK's live-timeline accessor.
  }
  if (Array.isArray(room.timeline)) return room.timeline;
  try {
    const events = room.getLiveTimeline?.()?.getEvents?.();
    if (Array.isArray(events)) return events;
  } catch {
    // A missing/evicted local timeline is resolved over the client API below.
  }
  return [];
}

async function replyAuthorIsBot(
  client: MatrixClientLike,
  roomId: string,
  eventId: string,
  userId: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  let local: readonly unknown[] = [];
  try {
    local = roomTimelineEvents(client.getRoom?.(roomId));
  } catch {
    local = [];
  }
  for (const candidate of local) {
    if (matrixEventId(candidate as MatrixEventLike) !== eventId) continue;
    return matrixEventSender(candidate as MatrixEventLike) === userId;
  }
  if (!client.fetchRoomEvent) return false;
  try {
    const target = await client.fetchRoomEvent(roomId, eventId, signal);
    if (signal?.aborted) return false;
    return matrixEventSender(target) === userId;
  } catch {
    return false;
  }
}

/** A bounded FIFO event-id set; duplicate tracking intentionally is not durable. */
export class EventDeduper {
  private readonly ids = new Set<string>();
  private readonly limit: number;

  constructor(limit = DEDUPE_LIMIT) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEDUPE_LIMIT;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
  }

  clear(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}

/**
 * Capture one eligible event and classify whether it opens a turn. Ordinary
 * mention-only room messages are returned with `trigger: false` so the bridge
 * can retain them as context.
 */
export async function captureMatrixEvent(
  event: MatrixEventLike,
  settings: Pick<MatrixSettings, "roomId" | "userId" | "respondToAll">,
  client: MatrixClientLike,
  toStartOfTimeline = false,
  data?: MatrixTimelineData,
  signal?: AbortSignal
): Promise<AdmittedMatrixMessage | undefined> {
  if (signal?.aborted) return undefined;
  if (toStartOfTimeline || data?.timeline === "back-paginate" || data?.timeline === "forward-paginate" || data?.liveEvent === false) return undefined;
  if (matrixEventType(event) !== "m.room.message") return undefined;
  const roomId = matrixEventRoomId(event);
  if (!roomId || roomId !== settings.roomId) return undefined;
  const sender = matrixEventSender(event);
  const eventId = matrixEventId(event);
  if (!sender || !eventId) return undefined;
  const clientUserId = client.getUserId?.();
  if (sender === settings.userId || (typeof clientUserId === "string" && sender === clientUserId)) return undefined;
  const content = matrixEventContent(event);
  const msgtype = content.msgtype;
  if (msgtype !== "m.text") return undefined;
  if (relationIsUnsupported(content)) return undefined;
  const body = typeof content.body === "string" ? content.body : "";
  const text = cleanMatrixPrompt(body, settings.userId);
  if (!text) return undefined;

  // Both speaker attribution and the optional display-label trigger read only
  // the current local member state. A missing label falls back to the sender
  // ID for records, but never becomes a label-trigger itself.
  const displayName = readLocalRoomDisplayName(client, roomId, sender) ?? sender.slice(0, MAX_PROVENANCE_CHARS);
  const botDisplayName = settings.respondToAll ? undefined : readLocalRoomDisplayName(client, roomId, settings.userId);
  const replyId = isReplyRelation(relatesTo(content));
  let trigger = settings.respondToAll;
  if (!trigger) {
    const reply = replyId ? await replyAuthorIsBot(client, roomId, replyId, settings.userId, signal) : false;
    trigger = hasMention(content, settings.userId) || reply || Boolean(botDisplayName && text.includes(botDisplayName));
  }
  const source: MatrixProvenance = {
    kind: "plugin",
    plugin: PACKAGE_NAME,
    roomId: roomId.slice(0, MAX_PROVENANCE_CHARS),
    sender: sender.slice(0, MAX_PROVENANCE_CHARS),
    eventId: eventId.slice(0, MAX_PROVENANCE_CHARS),
    ...(replyId ? { replyToEventId: replyId.slice(0, MAX_PROVENANCE_CHARS) } : {})
  };
  return {
    eventId,
    roomId,
    sender,
    displayName,
    text,
    source,
    trigger,
    ...(replyId ? { replyToEventId: replyId.slice(0, MAX_PROVENANCE_CHARS) } : {})
  };
}

/** Build the optional relation/mention metadata shared by every outbound message type. */
function matrixOptionalMessageMetadata(
  replyToEventId?: string,
  mentionUserIds?: readonly string[]
): Record<string, unknown> {
  return {
    ...(replyToEventId ? { "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } } } : {}),
    ...(mentionUserIds && mentionUserIds.length > 0 ? { "m.mentions": { user_ids: [...mentionUserIds] } } : {})
  };
}

/** Build one ordinary Matrix text payload, optionally carrying intentional user mentions. */
export function matrixTextMessage(
  roomId: string,
  body: string,
  replyToEventId?: string,
  mentionUserIds?: readonly string[]
): Record<string, unknown> {
  void roomId;
  return {
    msgtype: "m.text",
    body,
    ...matrixOptionalMessageMetadata(replyToEventId, mentionUserIds)
  };
}

/** Build one native Matrix media payload while retaining the fixed-room reply/mention metadata. */
export function matrixMediaMessage(
  msgtype: "m.audio" | "m.image" | "m.file",
  body: string,
  url: string,
  mimeType: string,
  size: number,
  options: {
    filename?: string | undefined;
    replyToEventId?: string | undefined;
    mentionUserIds?: readonly string[] | undefined;
  } = {}
): Record<string, unknown> {
  return {
    msgtype,
    body,
    url,
    ...(options.filename ? { filename: options.filename } : {}),
    info: { mimetype: mimeType, size },
    ...matrixOptionalMessageMetadata(options.replyToEventId, options.mentionUserIds)
  };
}
