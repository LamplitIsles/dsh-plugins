import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  MAX_MATRIX_MEDIA_BYTES,
  MAX_MATRIX_TOOL_BODY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_PROVENANCE_CHARS,
  MAX_ROOM_MEMBER_ID_CHARS,
  MAX_ROOM_MEMBERS
} from "./constants.js";
import {
  matrixEventContent,
  matrixEventId,
  matrixEventRoomId,
  matrixEventSender,
  matrixEventType,
  matrixMemberDisplayName,
  matrixMediaMessage,
  matrixTextMessage,
  readLocalRoomDisplayName,
  type MatrixContextRecord,
  type MatrixEventLike,
  type MatrixClientLike,
  type MatrixRoomLike
} from "./matrix-protocol.js";

export const MATRIX_LIST_MEMBERS = "matrix_list_members" as const;
export const MATRIX_READ_RECENT_MESSAGES = "matrix_read_recent_messages" as const;
export const MATRIX_SEND_MESSAGE = "matrix_send_message" as const;
export const MATRIX_SEND_FILE = "matrix_send_file" as const;
export const MAX_RECENT_MESSAGES = 50;
export { MAX_MATRIX_MEDIA_BYTES };
const MAX_RECENT_HISTORY_PAGES = 16;

export interface MatrixToolDependencies {
  /** Read the live connection at execution time, never a stale startup copy. */
  getClient: () => MatrixClientLike | undefined;
  /** The restart-scoped room allowlist; tools deliberately have no room argument. */
  roomId: string;
  /** The bridge gate; tools are unavailable before prepared sync or after failure. */
  isReady: () => boolean;
  /** Read the live locked Agent so optional DSH services are resolved per call. */
  getAgent?: () => MatrixToolAgentLike | undefined;
}

/** The small DSH filesystem seam used by workspace-file delivery. */
export interface MatrixFileSystemLike {
  resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }) => Promise<unknown>;
  contains: (parent: unknown, child: unknown) => boolean;
  stat: (target: unknown, signal?: AbortSignal) => Promise<{ type?: unknown; size?: unknown } | undefined>;
  readBytes: (target: unknown, signal: AbortSignal | undefined, maxBytes: number) => Promise<Uint8Array>;
}

/** Exact optional service contract recorded with the paired Kepos Speech plugin. */
export interface KeposSpeechServiceLike {
  synthesize: (
    request: { sessionId: string; text: string },
    signal?: AbortSignal
  ) => Promise<{ mediaType: "audio/mpeg"; data: Uint8Array }>;
}

export interface MatrixToolAgentLike {
  id: unknown;
  session?: { header?: { cwd?: unknown } };
  ctx?: {
    get?: (name: string) => unknown;
  };
}

export interface MatrixRoomMember {
  userId: string;
  displayName: string;
}

export interface MatrixListMembersResult {
  members: MatrixRoomMember[];
}

export interface MatrixReadRecentMessagesResult {
  messages: MatrixContextRecord[];
}

export interface MatrixSendMessageResult {
  sent: true;
}

export interface MatrixSendFileResult {
  sent: true;
}

class MatrixMentionCorrectionError extends Error {}
class MatrixReplyTargetError extends Error {}
class MatrixMediaError extends Error {}
class MatrixFileError extends Error {}

function abortError(): Error {
  return new Error("Matrix tool operation cancelled.");
}

function unavailableError(): Error {
  return new Error("Matrix connection or the configured room is unavailable.");
}

function notReadyError(): Error {
  return new Error("Matrix bridge is not ready: initial sync is not prepared.");
}

function sendFailureError(): Error {
  return new Error("Matrix message could not be sent.");
}

function voiceUnavailableError(): Error {
  return new MatrixMediaError("Matrix voice delivery is unavailable: the optional Kepos Speech service is not mounted.");
}

function voiceSynthesisError(): Error {
  return new MatrixMediaError("Matrix voice synthesis returned invalid audio.");
}

function mediaUploadError(): Error {
  return new MatrixMediaError("Matrix media upload failed.");
}

function filePathError(): Error {
  return new MatrixFileError("Matrix file path must be one non-empty path inside the active workspace.");
}

function fileWorkspaceError(): Error {
  return new MatrixFileError("Matrix file delivery is unavailable: the active workspace filesystem is unavailable.");
}

function fileContainmentError(): Error {
  return new MatrixFileError("Matrix file path must stay inside the active conversation workspace.");
}

function fileRegularError(): Error {
  return new MatrixFileError("Matrix file path must identify a regular file.");
}

function fileTooLargeError(): Error {
  return new MatrixFileError(`Matrix file exceeds the ${MAX_MATRIX_MEDIA_BYTES}-byte media limit.`);
}

function fileReadError(): Error {
  return new MatrixFileError("Matrix file could not be read from the active workspace.");
}

function replyTargetError(eventId: unknown): Error {
  const requested = typeof eventId === "string" ? eventId.slice(0, MAX_ROOM_MEMBER_ID_CHARS) : String(eventId ?? "").slice(0, MAX_ROOM_MEMBER_ID_CHARS);
  return new MatrixReplyTargetError(`Matrix reply event ID ${JSON.stringify(requested)} is not available in the configured Matrix room history.`);
}

function mentionCorrectionError(label: unknown, validDisplayLabels: readonly string[]): Error {
  const requested = typeof label === "string"
    ? label.slice(0, MAX_ROOM_MEMBER_ID_CHARS)
    : typeof label === "undefined" ? "" : String(label).slice(0, MAX_ROOM_MEMBER_ID_CHARS);
  const requestedJson = JSON.stringify(requested);
  const prefix = `Matrix mention label ${requestedJson} is unavailable or ambiguous. Valid display labels: `;
  const bounded = [...validDisplayLabels];
  let message = `${prefix}${JSON.stringify(bounded)}`;
  // Bound the complete correction error, not only the JSON array. Trimming
  // whole labels preserves valid JSON and deterministic correction data.
  while (message.length > MAX_PROMPT_CHARS && bounded.length > 0) {
    bounded.pop();
    message = `${prefix}${JSON.stringify(bounded)}`;
  }
  return new MatrixMentionCorrectionError(message);
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function ensureReady(deps: MatrixToolDependencies): void {
  let ready = false;
  try {
    ready = deps.isReady();
  } catch {
    ready = false;
  }
  if (!ready) throw notReadyError();
}

function memberUserId(member: unknown): string | undefined {
  if (!member || typeof member !== "object") return undefined;
  const value = member as {
    userId?: unknown;
    user_id?: unknown;
    getUserId?: () => unknown;
    membership?: unknown;
  };
  try {
    const fromGetter = value.getUserId?.();
    if (typeof fromGetter === "string" && fromGetter.trim()) return fromGetter.trim();
  } catch {
    // A malformed member is ignored; no profile data is needed by this tool.
  }
  if (typeof value.userId === "string" && value.userId.trim()) return value.userId.trim();
  if (typeof value.user_id === "string" && value.user_id.trim()) return value.user_id.trim();
  return undefined;
}

function currentJoinedMembers(room: MatrixRoomLike): readonly unknown[] {
  if (typeof room.getJoinedMembers === "function") {
    try {
      const members = room.getJoinedMembers();
      if (Array.isArray(members)) {
        return members.filter((member) => {
          if (!member || typeof member !== "object") return false;
          const membership = (member as { membership?: unknown }).membership;
          return membership === undefined || membership === "join";
        });
      }
    } catch {
      // Fall through to the current-members accessor when available.
    }
  }
  if (typeof room.getMembers === "function") {
    try {
      const members = room.getMembers();
      if (Array.isArray(members)) {
        return members.filter((member) => {
          if (!member || typeof member !== "object") return false;
          const membership = (member as { membership?: unknown }).membership;
          return membership === "join";
        });
      }
    } catch {
      // The caller turns this into the bounded unavailable error.
    }
  }
  throw unavailableError();
}

/** Read only current joined Matrix members, with deterministic and finite output. */
export function listJoinedMatrixMembers(client: MatrixClientLike | undefined, roomId: string): MatrixRoomMember[] {
  if (!client || !roomId.trim()) throw unavailableError();
  let room: MatrixRoomLike | null | undefined;
  try {
    room = client.getRoom?.(roomId);
  } catch {
    throw unavailableError();
  }
  if (!room) throw unavailableError();
  const members = new Map<string, MatrixRoomMember>();
  for (const member of currentJoinedMembers(room)) {
    const id = memberUserId(member);
    if (!id) continue;
    const userId = id.slice(0, MAX_ROOM_MEMBER_ID_CHARS);
    const candidate: MatrixRoomMember = {
      userId,
      displayName: matrixMemberDisplayName(member, id)?.slice(0, MAX_ROOM_MEMBER_ID_CHARS) ?? userId
    };
    const existing = members.get(userId);
    if (!existing || candidate.displayName < existing.displayName) members.set(userId, candidate);
  }
  const sorted = [...members.values()]
    .sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : 0)
    .slice(0, MAX_ROOM_MEMBERS);
  const bounded: MatrixRoomMember[] = [];
  let characters = 0;
  for (const member of sorted) {
    const line = `${member.displayName} (${member.userId})`;
    const separator = bounded.length === 0 ? 0 : 1;
    if (characters + separator + line.length > MAX_PROMPT_CHARS) break;
    bounded.push(member);
    characters += separator + line.length;
  }
  return bounded;
}

function toolText(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

function toolSignal(exec: ToolRunContext): AbortSignal {
  return exec?.signal ?? new AbortController().signal;
}

function validMessageBody(body: unknown): body is string {
  return typeof body === "string" && body.trim().length > 0 && body.length <= MAX_MATRIX_TOOL_BODY_CHARS;
}

function agentService(agent: MatrixToolAgentLike | undefined, name: string): unknown {
  if (!agent?.ctx) return undefined;
  try {
    const value = agent.ctx.get?.(name);
    if (value !== undefined) return value;
  } catch {
    // Optional services may disappear with their provider fiber.
  }
  try {
    return (agent.ctx as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function liveAgent(deps: MatrixToolDependencies, exec?: ToolRunContext): MatrixToolAgentLike | undefined {
  const executionAgent = exec?.agent;
  if (executionAgent) return executionAgent as unknown as MatrixToolAgentLike;
  try {
    return deps.getAgent?.();
  } catch {
    return undefined;
  }
}

function matrixFileSystem(agent: MatrixToolAgentLike | undefined): MatrixFileSystemLike | undefined {
  const candidate = agentService(agent, "fs");
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Partial<MatrixFileSystemLike>;
  if (typeof value.resolve !== "function"
    || typeof value.contains !== "function"
    || typeof value.stat !== "function"
    || typeof value.readBytes !== "function") return undefined;
  return value as MatrixFileSystemLike;
}

function workspaceCwd(agent: MatrixToolAgentLike | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function basenameForPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const last = normalized.split(/[\\/]/).pop() ?? "";
  return last || normalized;
}

function validFilePath(path: unknown): path is string {
  return typeof path === "string"
    && path.length > 0
    && path.length <= MAX_MATRIX_TOOL_BODY_CHARS
    && path.trim().length > 0
    && !path.includes("\0")
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

function validDescription(description: unknown): description is string {
  return typeof description === "string"
    && description.length <= MAX_MATRIX_TOOL_BODY_CHARS;
}

function imageMediaType(filename: string): string | undefined {
  switch (filename.toLowerCase().split(".").pop()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return undefined;
  }
}

function mediaTypeForFilename(filename: string): { msgtype: "m.image" | "m.file"; mimeType: string } {
  const imageType = imageMediaType(filename);
  return imageType
    ? { msgtype: "m.image", mimeType: imageType }
    : { msgtype: "m.file", mimeType: "application/octet-stream" };
}

function validAudio(value: unknown): value is { mediaType: "audio/mpeg"; data: Uint8Array } {
  if (!value || typeof value !== "object") return false;
  const result = value as { mediaType?: unknown; data?: unknown };
  return result.mediaType === "audio/mpeg"
    && result.data instanceof Uint8Array
    && result.data.byteLength > 0
    && result.data.byteLength <= MAX_MATRIX_MEDIA_BYTES;
}

function safeContentUri(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVENANCE_CHARS;
}

async function uploadMatrixMedia(
  client: MatrixClientLike,
  data: Uint8Array,
  name: string,
  mimeType: string,
  signal: AbortSignal
): Promise<string> {
  ensureNotAborted(signal);
  if (typeof client.uploadContent !== "function") throw mediaUploadError();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const uploaded = await client.uploadContent(data, {
      name,
      type: mimeType,
      abortController
    });
    ensureNotAborted(signal);
    const uri = uploaded?.content_uri;
    if (!safeContentUri(uri)) throw mediaUploadError();
    return uri;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof MatrixMediaError) throw error;
    throw mediaUploadError();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function sendMatrixContent(
  client: MatrixClientLike,
  roomId: string,
  content: Record<string, unknown>
): Promise<void> {
  try {
    if (client.sendMessage) {
      await client.sendMessage(roomId, content);
      return;
    }
    if (client.sendEvent) {
      await client.sendEvent(roomId, "m.room.message", content);
      return;
    }
    throw sendFailureError();
  } catch (error) {
    if (error instanceof Error && error.message === "Matrix message could not be sent.") throw error;
    throw sendFailureError();
  }
}

async function resolveWorkspaceFile(
  agent: MatrixToolAgentLike | undefined,
  path: unknown,
  signal: AbortSignal
): Promise<{ data: Uint8Array; filename: string }> {
  if (!validFilePath(path)) throw filePathError();
  const fs = matrixFileSystem(agent);
  const cwd = workspaceCwd(agent);
  if (!fs || !cwd) throw fileWorkspaceError();
  ensureNotAborted(signal);
  let root: unknown;
  let target: unknown;
  try {
    root = await fs.resolve(cwd, { cwd, signal });
    target = await fs.resolve(path, { cwd, signal });
    ensureNotAborted(signal);
    if (!fs.contains(root, target)) throw fileContainmentError();
    const info = await fs.stat(target, signal);
    ensureNotAborted(signal);
    if (!info || info.type !== "file") throw fileRegularError();
    if (typeof info.size === "number" && (!Number.isFinite(info.size) || info.size < 0)) throw fileReadError();
    if (typeof info.size === "number" && info.size > MAX_MATRIX_MEDIA_BYTES) throw fileTooLargeError();
    const data = await fs.readBytes(target, signal, MAX_MATRIX_MEDIA_BYTES);
    ensureNotAborted(signal);
    if (!(data instanceof Uint8Array)) throw fileReadError();
    if (data.byteLength > MAX_MATRIX_MEDIA_BYTES) throw fileTooLargeError();
    const displayPath = target && typeof target === "object" && typeof (target as { displayPath?: unknown }).displayPath === "string"
      ? (target as { displayPath: string }).displayPath
      : path;
    const filename = basenameForPath(displayPath);
    if (!filename || filename === "." || filename === "..") throw filePathError();
    return { data, filename };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof MatrixFileError) throw error;
    throw fileReadError();
  }
}

function validRecentLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_RECENT_MESSAGES;
}

async function verifyReplyTarget(client: MatrixClientLike, roomId: string, eventId: unknown, signal: AbortSignal): Promise<string> {
  if (typeof eventId !== "string" || !eventId.trim() || eventId.length > MAX_PROVENANCE_CHARS || !client.fetchRoomEvent) throw replyTargetError(eventId);
  try {
    const event = await client.fetchRoomEvent(roomId, eventId, signal);
    if (signal.aborted || matrixEventId(event) !== eventId) throw replyTargetError(eventId);
    const returnedRoomId = matrixEventRoomId(event);
    if (returnedRoomId !== undefined && returnedRoomId !== roomId) throw replyTargetError(eventId);
    return eventId;
  } catch (error) {
    if (error instanceof MatrixReplyTargetError) throw error;
    throw replyTargetError(eventId);
  }
}

function supportedRecentText(event: MatrixEventLike, roomId: string): MatrixContextRecord | undefined {
  if (matrixEventType(event) !== "m.room.message") return undefined;
  const eventId = matrixEventId(event);
  const sender = matrixEventSender(event);
  if (!eventId || !sender) return undefined;
  const content = matrixEventContent(event);
  if (content.msgtype !== "m.text" || typeof content.body !== "string" || !content.body.trim()) return undefined;
  if (content.format === "org.matrix.custom.html" || typeof content.formatted_body === "string") return undefined;
  const relation = content["m.relates_to"];
  if (relation && typeof relation === "object") {
    const relationType = (relation as { rel_type?: unknown }).rel_type;
    if (relationType !== undefined && relationType !== "") return undefined;
  }
  return {
    eventId: eventId.slice(0, MAX_PROVENANCE_CHARS),
    roomId,
    sender: sender.slice(0, MAX_PROVENANCE_CHARS),
    displayName: sender.slice(0, MAX_PROVENANCE_CHARS),
    text: content.body.trim()
  };
}

/** Retrieve bounded server history until enough usable records are found, then return them chronologically. */
export async function readRecentMatrixMessages(client: MatrixClientLike | undefined, roomId: string, last: number): Promise<MatrixContextRecord[]> {
  if (!client || !roomId.trim() || !validRecentLimit(last) || !client.createMessagesRequest) throw unavailableError();
  const events: MatrixEventLike[] = [];
  let fromToken: string | null = null;
  try {
    for (let page = 0; page < MAX_RECENT_HISTORY_PAGES; page += 1) {
      const response = await client.createMessagesRequest(roomId, fromToken, last, "b");
      events.push(...response.chunk);
      if (events.filter((event) => supportedRecentText(event, roomId) !== undefined).length >= last) break;
      if (!response.end || response.end === fromToken) break;
      fromToken = response.end;
    }
  } catch {
    throw unavailableError();
  }
  const records: MatrixContextRecord[] = [];
  let characters = 0;
  for (const event of events) {
    const record = supportedRecentText(event, roomId);
    if (!record) continue;
    record.displayName = readLocalRoomDisplayName(client, roomId, record.sender) ?? record.sender;
    const rendered = `${record.displayName} (${record.sender})\n${record.text}`;
    if (records.length >= last || characters + rendered.length > MAX_PROMPT_CHARS) continue;
    records.push(record);
    characters += rendered.length;
  }
  return records.reverse();
}

function isMatrixUserId(value: string): boolean {
  return value.startsWith("@") && value.includes(":");
}

function validDisplayLabels(members: readonly MatrixRoomMember[]): string[] {
  const labels = new Set<string>();
  const bounded: string[] = [];
  for (const member of members) {
    // An ID fallback is useful in the roster, but is deliberately not an
    // Agent-facing mention label: mention arguments remain display-label-only.
    if (member.displayName === member.userId || member.displayName === "@room" || isMatrixUserId(member.displayName)) continue;
    labels.add(member.displayName);
  }
  for (const label of labels) {
    const candidate = [...bounded, label];
    // JSON escaping can expand hostile labels beyond the roster's rendered
    // bound. Keep correction data finite while retaining all ordinary labels.
    if (JSON.stringify(candidate).length > MAX_PROMPT_CHARS - MAX_ROOM_MEMBER_ID_CHARS) break;
    bounded.push(label);
  }
  return bounded;
}

function sameRoster(left: readonly MatrixRoomMember[], right: readonly MatrixRoomMember[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    return other?.userId === member.userId && other.displayName === member.displayName;
  });
}

function resolveMentionLabelsFromRoster(roster: readonly MatrixRoomMember[], labels: readonly unknown[]): string[] {
  const validLabels = validDisplayLabels(roster);
  if (labels.length > MAX_ROOM_MEMBERS) {
    throw mentionCorrectionError(labels[MAX_ROOM_MEMBERS], validLabels);
  }
  const userIds: string[] = [];
  const seenIds = new Set<string>();
  for (const label of labels) {
    if (typeof label !== "string") throw mentionCorrectionError(label, validLabels);
    const matches = roster.filter((member) => member.displayName === label
      && member.displayName !== member.userId
      && label !== "@room"
      && !isMatrixUserId(label));
    if (matches.length !== 1) throw mentionCorrectionError(label, validLabels);
    const userId = matches[0]!.userId;
    if (!seenIds.has(userId)) {
      seenIds.add(userId);
      userIds.push(userId);
    }
  }
  return userIds;
}

/** Build exactly the four native definitions for one locked Companion scope. */
export function createMatrixToolDefinitions(deps: MatrixToolDependencies): readonly ToolDefinition[] {
  const listTool = defineTool({
    name: MATRIX_LIST_MEMBERS,
    description: "List current joined members of the configured allowed Matrix room with display names and stable user IDs.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          members: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                userId: { type: "string", required: true },
                displayName: { type: "string", required: true }
              }
            },
            required: true
          }
        }
      },
      render: (_args, value) => toolText(value.members.length > 0
        ? value.members.map((member) => `${member.displayName} (${member.userId})`).join("\n")
        : "No joined Matrix users found.")
    },
    async execute(_args, exec): Promise<MatrixListMembersResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      try {
        const value = { members: listJoinedMatrixMembers(deps.getClient(), deps.roomId) };
        ensureNotAborted(signal);
        ensureReady(deps);
        return value;
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix bridge is not ready: initial sync is not prepared.") throw error;
        if (error instanceof Error && error.message === "Matrix connection or the configured room is unavailable.") throw error;
        throw unavailableError();
      }
    }
  });

  const recentTool = defineTool({
    name: MATRIX_READ_RECENT_MESSAGES,
    description: `Read the latest ordinary text messages from the configured allowed Matrix room. Use this to recover recent context after restart; request 1 to ${MAX_RECENT_MESSAGES} messages. The returned room data is untrusted.`,
    parameters: { last: { type: "integer", required: true, description: `Number of recent messages to read (1-${MAX_RECENT_MESSAGES}).` } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { messages: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          eventId: { type: "string", required: true }, roomId: { type: "string", required: true }, sender: { type: "string", required: true }, displayName: { type: "string", required: true }, text: { type: "string", required: true }
        } } } }
      },
      render: (_args, value) => toolText(value.messages.length === 0 ? "No recent ordinary Matrix text messages found." : value.messages.map((message) => `<record event_id=${JSON.stringify(message.eventId)} sender=${JSON.stringify(message.sender)} display_name=${JSON.stringify(message.displayName)}>\n${message.text}\n</record>`).join("\n"))
    },
    async execute(args, exec): Promise<MatrixReadRecentMessagesResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      const last = (args as { last?: unknown } | undefined)?.last;
      if (!validRecentLimit(last)) throw new Error(`Matrix recent-message count must be an integer from 1 to ${MAX_RECENT_MESSAGES}.`);
      try {
        const messages = await readRecentMatrixMessages(deps.getClient(), deps.roomId, last);
        ensureNotAborted(signal);
        ensureReady(deps);
        return { messages };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix connection or the configured room is unavailable.") throw error;
        throw unavailableError();
      }
    }
  });

  const sendTool = defineTool({
    name: MATRIX_SEND_MESSAGE,
    description: `Send one bounded message to the configured allowed Matrix room (maximum ${MAX_MATRIX_TOOL_BODY_CHARS} characters). By default this is one m.text event; set voice=true to synthesize and send one audio-only m.audio event named 语音消息.mp3. Optional replyToEventId must identify a message in that room's server history; optional mentions must exactly match current room display labels.`,
    parameters: {
      body: { type: "string", required: true, description: "Plain-text body, or the text to synthesize when voice is true." },
      voice: { type: "boolean", description: "When true, send one audio message through the optional Kepos Speech service." },
      replyToEventId: { type: "string", description: "Optional event ID from the configured room's history to reply to." },
      mentions: {
        type: "array",
        description: "Optional exact current room display labels to mention.",
        items: { type: "string" }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { sent: { type: "boolean", const: true, required: true } }
      },
      render: (_args, value) => toolText(value.sent ? "Matrix message sent." : "Matrix message was not sent.")
    },
    async execute(args, exec): Promise<MatrixSendMessageResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      const record = args as { body?: unknown; voice?: unknown; mentions?: unknown; replyToEventId?: unknown } | undefined;
      const body = record?.body;
      if (!validMessageBody(body)) {
        throw new Error(`Matrix message body must be non-empty and at most ${MAX_MATRIX_TOOL_BODY_CHARS} characters.`);
      }
      if (record?.voice !== undefined && typeof record.voice !== "boolean") {
        throw new Error("Matrix voice option must be a boolean.");
      }
      try {
        ensureReady(deps);
        const client = deps.getClient();
        if (!client || !deps.roomId.trim()) throw unavailableError();
        const rawMentions = record?.mentions;
        const requestedReplyToEventId = record?.replyToEventId;
        const replyToEventId = requestedReplyToEventId === undefined
          ? undefined
          : await verifyReplyTarget(client, deps.roomId, requestedReplyToEventId, signal);
        if (rawMentions !== undefined && !Array.isArray(rawMentions)) {
          throw mentionCorrectionError(rawMentions, []);
        }
        let mentionUserIds: readonly string[] | undefined;
        if (Array.isArray(rawMentions) && rawMentions.length > 0) {
          const firstRoster = listJoinedMatrixMembers(client, deps.roomId);
          resolveMentionLabelsFromRoster(firstRoster, rawMentions);
          // Local room state is synchronous, but re-read it immediately before
          // the send so a roster mutation after resolution fails closed with the
          // same correction-oriented error and emits no event.
          const currentRoster = listJoinedMatrixMembers(client, deps.roomId);
          if (!sameRoster(firstRoster, currentRoster)) {
            throw mentionCorrectionError(rawMentions[0], validDisplayLabels(currentRoster));
          }
          // Resolve against the verified second snapshot too. This keeps the
          // IDs and labels in one coherent local roster snapshot.
          mentionUserIds = resolveMentionLabelsFromRoster(currentRoster, rawMentions);
        }

        if (record?.voice === true) {
          const agent = liveAgent(deps, exec);
          const service = agentService(agent, "keposSpeech");
          if (!service || typeof service !== "object" || typeof (service as { synthesize?: unknown }).synthesize !== "function") {
            throw voiceUnavailableError();
          }
          const sessionId = typeof agent?.id === "string" ? agent.id : String(agent?.id ?? "");
          if (!sessionId) throw voiceUnavailableError();
          let synthesized: unknown;
          try {
            synthesized = await (service as KeposSpeechServiceLike).synthesize({ sessionId, text: body }, signal);
          } catch (error) {
            if (signal.aborted) throw abortError();
            throw voiceSynthesisError();
          }
          ensureNotAborted(signal);
          ensureReady(deps);
          if (!validAudio(synthesized)) throw voiceSynthesisError();
          const audio = synthesized as { mediaType: "audio/mpeg"; data: Uint8Array };
          const url = await uploadMatrixMedia(client, audio.data, "语音消息.mp3", audio.mediaType, signal);
          ensureNotAborted(signal);
          ensureReady(deps);
          const content = matrixMediaMessage("m.audio", "语音消息.mp3", url, audio.mediaType, audio.data.byteLength, {
            replyToEventId,
            mentionUserIds
          });
          await sendMatrixContent(client, deps.roomId, content);
          ensureNotAborted(signal);
          ensureReady(deps);
          return { sent: true };
        }

        const content = matrixTextMessage(deps.roomId, body, replyToEventId, mentionUserIds);
        ensureNotAborted(signal);
        ensureReady(deps);
        await sendMatrixContent(client, deps.roomId, content);
        ensureNotAborted(signal);
        ensureReady(deps);
        return { sent: true };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix bridge is not ready: initial sync is not prepared.") throw error;
        if (error instanceof MatrixMentionCorrectionError) throw error;
        if (error instanceof MatrixReplyTargetError) throw error;
        if (error instanceof MatrixMediaError) throw error;
        if (error instanceof Error && (error.message === "Matrix message could not be sent." || error.message === "Matrix connection or the configured room is unavailable.")) throw error;
        throw sendFailureError();
      }
    }
  });

  const fileTool = defineTool({
    name: MATRIX_SEND_FILE,
    description: `Send one regular file from the active conversation workspace to the configured allowed Matrix room. PNG, JPEG, WebP, and GIF files become m.image; all other files become m.file with application/octet-stream. Optional description becomes the visible Matrix body, otherwise the basename is used. Maximum ${MAX_MATRIX_MEDIA_BYTES} bytes; optional replyToEventId must identify a message in that room's server history.`,
    parameters: {
      path: { type: "string", required: true, description: "One path inside the active conversation workspace." },
      description: { type: "string", description: "Optional visible Matrix body for the file event." },
      replyToEventId: { type: "string", description: "Optional event ID from the configured room's history to reply to." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { sent: { type: "boolean", const: true, required: true } }
      },
      render: (_args, value) => toolText(value.sent ? "Matrix file sent." : "Matrix file was not sent.")
    },
    async execute(args, exec): Promise<MatrixSendFileResult> {
      const signal = toolSignal(exec);
      ensureNotAborted(signal);
      ensureReady(deps);
      const record = args as { path?: unknown; description?: unknown; replyToEventId?: unknown } | undefined;
      const path = record?.path;
      if (!validFilePath(path)) throw filePathError();
      const description = record?.description;
      if (description !== undefined && !validDescription(description)) {
        throw new MatrixFileError(`Matrix file description must be at most ${MAX_MATRIX_TOOL_BODY_CHARS} characters.`);
      }
      try {
        ensureReady(deps);
        const client = deps.getClient();
        if (!client || !deps.roomId.trim()) throw unavailableError();
        const requestedReplyToEventId = record?.replyToEventId;
        const replyToEventId = requestedReplyToEventId === undefined
          ? undefined
          : await verifyReplyTarget(client, deps.roomId, requestedReplyToEventId, signal);
        const resolved = await resolveWorkspaceFile(liveAgent(deps, exec), path, signal);
        ensureReady(deps);
        const visibleBody = description === undefined ? resolved.filename : description;
        const media = mediaTypeForFilename(resolved.filename);
        const url = await uploadMatrixMedia(client, resolved.data, resolved.filename, media.mimeType, signal);
        ensureNotAborted(signal);
        ensureReady(deps);
        const content = matrixMediaMessage(media.msgtype, visibleBody, url, media.mimeType, resolved.data.byteLength, {
          filename: resolved.filename,
          replyToEventId
        });
        await sendMatrixContent(client, deps.roomId, content);
        ensureNotAborted(signal);
        ensureReady(deps);
        return { sent: true };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (error instanceof Error && error.message === "Matrix bridge is not ready: initial sync is not prepared.") throw error;
        if (error instanceof MatrixReplyTargetError) throw error;
        if (error instanceof MatrixFileError) throw error;
        if (error instanceof MatrixMediaError) throw error;
        if (error instanceof Error && (error.message === "Matrix message could not be sent." || error.message === "Matrix connection or the configured room is unavailable.")) throw error;
        throw fileReadError();
      }
    }
  });

  return [listTool, recentTool, sendTool, fileTool];
}
