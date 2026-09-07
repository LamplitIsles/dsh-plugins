import { credentialRef, type CredentialProvider, type ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import type { HostConnectionRpc, ConnectionRpcHandler, ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";

import {
  ALIBABA_CREDENTIAL_REF,
  ALIBABA_MODEL,
  BYTEDANCE_ENDPOINT,
  BYTEDANCE_RESOURCE_ID,
  DASHSCOPE_ENDPOINT,
  MAX_ASR_DATA_URL_BYTES,
  QWEN_ASR_EXPRESSIONS,
  QWEN_ASR_LANGUAGES,
  QWEN_ASR_MEDIA_TYPES,
  QWEN_ASR_MODEL,
  SPEECH_MAX_CHARS,
  profileFromSettings,
  type QwenAsrExpression,
  type QwenAsrLanguage,
  type SpeechProfile
} from "./constants.js";
import { normalizeSpeechText } from "./parser.js";
import {
  AUDIO_ROUTE_PATH,
  CACHE_FORMAT_VERSION,
  MAX_AUDIO_BYTES,
  SPEECH_CACHE_DIRECTORY,
  audioArtifactPath,
  audioCacheDirectory,
  audioUrl,
  cacheDigest,
  readAudioArtifact,
  readAudioArtifactMetadata,
  registerSpeechAudioRoute,
  resolveSessionWorkspace,
  serveSpeechAudio,
  writeAudioArtifactAtomic,
  type AudioRouteRegistrar,
  type AudioResponse,
  type SessionResolver
} from "./audio-cache.js";
import { RPC_CHANNEL, RPC_ENDPOINT, type BrowserAudioPayload } from "./rpc.js";

export type SpeechFailureCategory =
  | "invalid-input"
  | "unavailable"
  | "provider-rejected"
  | "provider-invalid-audio"
  | "provider-invalid-transcription"
  | "internal"
  | "cancelled";

export interface SpeechFailureDiagnostic {
  category: SpeechFailureCategory;
  provider?: SpeechProfile["provider"];
  voice?: string;
  stage?: "session" | "credential" | "network" | "http" | "provider-response";
  httpStatus?: number;
  responseContentType?: string;
  responseBytes?: number;
  requestId?: string;
  responseIssue?: "read-failed" | "invalid-json" | "invalid-frame" | "no-data-frames" | "invalid-transcription";
}

/** Stable input accepted by the optional Host-facing `keposSpeech` service. */
export interface KeposSpeechSynthesisRequest {
  sessionId: string;
  text: string;
}

/** Bounded MP3 payload returned by the optional Host-facing `keposSpeech` service. */
export interface KeposSpeechAudio {
  mediaType: "audio/mpeg";
  data: Uint8Array;
}

/** A short audio attachment accepted by the Host-only Qwen ASR operation. */
export interface KeposSpeechTranscriptionRequest {
  sessionId: string;
  mediaType: string;
  data: Uint8Array;
  /** Optional recognition hint; it is never returned as a detected result. */
  language?: QwenAsrLanguage;
}

/** Provider-neutral Qwen ASR result returned to a trusted Host caller. */
export interface KeposSpeechTranscription {
  text: string;
  /** Audio-level language annotation from the model, when present. */
  language?: QwenAsrLanguage;
  /** Audio-level model classification, not a fact about the speaker's inner state. */
  expression?: QwenAsrExpression;
}

/** Optional in-process Host capability offered while the Kepos plugin is mounted. */
export interface KeposSpeechService {
  synthesize(request: KeposSpeechSynthesisRequest, signal?: AbortSignal): Promise<KeposSpeechAudio>;
  transcribe(request: KeposSpeechTranscriptionRequest, signal?: AbortSignal): Promise<KeposSpeechTranscription>;
}

/** Cordis key for the optional Host Speech capability. */
export const KEPOS_SPEECH_SERVICE = "keposSpeech" as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Optional Host Speech capability supplied by Kepos Speech when mounted. */
    keposSpeech: KeposSpeechService;
  }
}

export { RPC_CHANNEL, RPC_ENDPOINT } from "./rpc.js";
export type { BrowserAudioPayload } from "./rpc.js";
export {
  AUDIO_ROUTE_PATH,
  CACHE_FORMAT_VERSION,
  MAX_AUDIO_BYTES,
  SPEECH_CACHE_DIRECTORY,
  audioArtifactPath,
  audioCacheDirectory,
  audioUrl,
  cacheDigest,
  readAudioArtifact,
  readAudioArtifactMetadata,
  registerSpeechAudioRoute,
  resolveSessionWorkspace,
  serveSpeechAudio,
  writeAudioArtifactAtomic
} from "./audio-cache.js";
export type { AudioRouteRegistrar, AudioResponse, SessionResolver } from "./audio-cache.js";

export interface CredentialResolver {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<ResolvedCredential | undefined>;
}

export interface SpeechGatewayOptions {
  credentials: CredentialResolver | Pick<CredentialProvider, "resolve">;
  sessions: SessionResolver;
  /** Normalized settings are resolved for each admitted cache miss. */
  getSettings: () => unknown;
  fetch?: typeof fetch;
  onFailure?: (failure: SpeechFailureDiagnostic) => void;
}

export class SpeechGatewayError extends Error {
  readonly category: SpeechFailureCategory;
  readonly diagnostic: Omit<SpeechFailureDiagnostic, "category">;

  constructor(category: SpeechFailureCategory, diagnostic: Omit<SpeechFailureDiagnostic, "category"> = {}) {
    super(category);
    this.name = "SpeechGatewayError";
    this.category = category;
    this.diagnostic = diagnostic;
  }
}

function reportGatewayFailure(error: unknown, onFailure?: (failure: SpeechFailureDiagnostic) => void): SpeechGatewayError {
  const typed = error instanceof SpeechGatewayError ? error : new SpeechGatewayError("internal");
  if (typed.category !== "invalid-input" && typed.category !== "cancelled") {
    try {
      onFailure?.({ category: typed.category, ...typed.diagnostic });
    } catch {
      // Observability must not change the operation result.
    }
  }
  return typed;
}

function providerDiagnostic(
  profile: Pick<SpeechProfile, "provider" | "voice">,
  stage: NonNullable<SpeechFailureDiagnostic["stage"]>,
  detail: Pick<SpeechFailureDiagnostic, "httpStatus" | "responseContentType" | "responseBytes" | "requestId" | "responseIssue"> = {}
): Omit<SpeechFailureDiagnostic, "category"> {
  return { provider: profile.provider, voice: profile.voice, stage, ...detail };
}

function failure<T>(category: SpeechFailureCategory): ConnectionRpcResult<T> {
  const code = category === "invalid-input" ? "bad-request" : category === "cancelled" ? "cancelled" : "internal";
  if (code === "bad-request") {
    return {
      ok: false,
      error: { code, message: category, details: { issues: [] } }
    } as ConnectionRpcResult<T>;
  }
  if (code === "cancelled") {
    return { ok: false, error: { code, message: category, details: {} } } as ConnectionRpcResult<T>;
  }
  return { ok: false, error: { code: "internal", message: category, details: {} } } as ConnectionRpcResult<T>;
}

/** Leave enough room for JSON framing while bounding any provider response. */
const MAX_PROVIDER_JSON_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64 * 1024;

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new Error("response-too-large");
    }
  }
  if (!response.body) throw new Error("empty-response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseDiagnostic(response: Response, responseBytes?: number): Pick<SpeechFailureDiagnostic, "responseContentType" | "responseBytes" | "requestId"> {
  const responseContentType = response.headers.get("content-type")?.slice(0, 128);
  const requestId = (
    response.headers.get("x-tt-logid")
    ?? response.headers.get("x-dashscope-request-id")
    ?? response.headers.get("x-request-id")
    ?? response.headers.get("x-api-request-id")
  )?.slice(0, 256);
  return {
    ...(responseContentType ? { responseContentType } : {}),
    ...(responseBytes === undefined ? {} : { responseBytes }),
    ...(requestId ? { requestId } : {})
  };
}

async function httpProviderRejection(
  response: Response,
  profile: Pick<SpeechProfile, "provider" | "voice">
): Promise<SpeechGatewayError> {
  let responseBytes: number | undefined;
  try {
    const body = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseBytes = body.byteLength;
  } catch {
    // The HTTP status still provides a safe diagnostic when the body is absent or oversized.
  }
  return new SpeechGatewayError("provider-rejected", providerDiagnostic(profile, "http", {
    httpStatus: response.status,
    ...responseDiagnostic(response, responseBytes)
  }));
}

/** Strict base64 decoding; Buffer.from alone silently accepts malformed input. */
function base64ToBytes(value: string): Uint8Array | undefined {
  const dataUri = value.match(/^data:[^;,]+;base64,(.*)$/s);
  if (dataUri) value = dataUri[1]!;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  if (value.includes("=") && value.length % 4 !== 0) return undefined;
  const encoded = value + padding;
  try {
    const buffer = (globalThis as { Buffer?: { from(value: string, encoding: string): Uint8Array } }).Buffer;
    if (buffer) {
      return new Uint8Array(buffer.from(encoded, "base64"));
    }
    const decoded = atob(encoded);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Encode attachment bytes without building an argument list proportional to the file. */
function bytesToBase64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (buffer) return buffer.from(bytes).toString("base64");
  let encoded = "";
  // Keep every chunk on a three-byte boundary so concatenating the encoded
  // chunks is equivalent to encoding the complete byte sequence.
  const chunkSize = 0x7ffe;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}

function dataUrlLength(mediaType: string, byteLength: number): number {
  return `data:${mediaType};base64,`.length + Math.ceil(byteLength / 3) * 4;
}

interface ParsedTranscriptionRequest {
  sessionId: string;
  mediaType: string;
  data: Uint8Array;
  language?: QwenAsrLanguage;
}

function transcriptionRequestFromPayload(payload: unknown): ParsedTranscriptionRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SpeechGatewayError("invalid-input");
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set(["sessionId", "mediaType", "data", "language"]);
  if (
    keys.some((key) => !allowed.has(key))
    || !keys.includes("sessionId")
    || !keys.includes("mediaType")
    || !keys.includes("data")
  ) {
    throw new SpeechGatewayError("invalid-input");
  }
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
    throw new SpeechGatewayError("invalid-input");
  }
  if (!(record.data instanceof Uint8Array) || record.data.byteLength === 0) {
    throw new SpeechGatewayError("invalid-input");
  }

  if (typeof record.mediaType !== "string" || record.mediaType.length > 256) {
    throw new SpeechGatewayError("invalid-input");
  }
  const mediaType = record.mediaType.trim().toLowerCase();
  const baseMediaType = mediaType.split(";", 1)[0]?.trim();
  if (
    !baseMediaType
    || !QWEN_ASR_MEDIA_TYPES.includes(baseMediaType as (typeof QWEN_ASR_MEDIA_TYPES)[number])
    || !/^audio\/[a-z0-9][a-z0-9.+-]*$/u.test(baseMediaType)
    || !/^audio\/[a-z0-9][a-z0-9.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/u.test(mediaType)
  ) {
    throw new SpeechGatewayError("invalid-input");
  }
  if (dataUrlLength(mediaType, record.data.byteLength) > MAX_ASR_DATA_URL_BYTES) {
    throw new SpeechGatewayError("invalid-input");
  }

  const languageValue = record.language;
  let language: QwenAsrLanguage | undefined;
  if (languageValue !== undefined) {
    if (typeof languageValue !== "string") throw new SpeechGatewayError("invalid-input");
    const normalized = languageValue.trim().toLowerCase();
    if (!QWEN_ASR_LANGUAGES.includes(normalized as QwenAsrLanguage)) throw new SpeechGatewayError("invalid-input");
    language = normalized as QwenAsrLanguage;
  }
  return {
    sessionId: record.sessionId,
    mediaType,
    data: record.data,
    ...(language === undefined ? {} : { language })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function languageValue(value: unknown): QwenAsrLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return QWEN_ASR_LANGUAGES.includes(normalized as QwenAsrLanguage)
    ? normalized as QwenAsrLanguage
    : undefined;
}

function expressionValue(value: unknown): QwenAsrExpression | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return QWEN_ASR_EXPRESSIONS.includes(normalized as QwenAsrExpression)
    ? normalized as QwenAsrExpression
    : undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string") return undefined;
    parts.push(item.text);
  }
  return parts.join("");
}

function syncAnnotations(value: unknown): { language?: QwenAsrLanguage; expression?: QwenAsrExpression } {
  if (!Array.isArray(value)) return {};
  let language: QwenAsrLanguage | undefined;
  let expression: QwenAsrExpression | undefined;
  for (const annotation of value) {
    if (!isRecord(annotation)) continue;
    language ??= languageValue(annotation.language);
    expression ??= expressionValue(annotation.emotion);
  }
  return {
    ...(language === undefined ? {} : { language }),
    ...(expression === undefined ? {} : { expression })
  };
}

/** Normalize the bounded provider body and discard provider-specific fields. */
export function normalizeQwenAsrResponse(body: unknown): KeposSpeechTranscription {
  if (!isRecord(body)) throw new Error("invalid-transcription");
  const output = isRecord(body.output) ? body.output : undefined;
  const choices = output && Array.isArray(output.choices) ? output.choices : undefined;
  const choice = choices?.[0];
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  const text = message ? textFromContent(message.content) : undefined;
  if (text === undefined) throw new Error("invalid-transcription");
  const annotations = syncAnnotations(message?.annotations);
  return {
    text,
    ...(annotations.language === undefined ? {} : { language: annotations.language }),
    ...(annotations.expression === undefined ? {} : { expression: annotations.expression })
  };
}

function requestFromPayload(payload: unknown): KeposSpeechSynthesisRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SpeechGatewayError("invalid-input");
  }
  const record = payload as { text?: unknown; sessionId?: unknown };
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "text" && key !== "sessionId") || !keys.includes("text") || !keys.includes("sessionId")) {
    throw new SpeechGatewayError("invalid-input");
  }
  if (typeof record.text !== "string" || typeof record.sessionId !== "string" || !record.sessionId.trim()) {
    throw new SpeechGatewayError("invalid-input");
  }
  const text = normalizeSpeechText(record.text);
  if (!text || Array.from(text).length > SPEECH_MAX_CHARS) throw new SpeechGatewayError("invalid-input");
  return { text, sessionId: record.sessionId };
}

function providerAudio(response: unknown): { data?: string; url?: string } | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const output = (response as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return undefined;
  const audio = (output as { audio?: unknown }).audio;
  if (typeof audio !== "object" || audio === null) return undefined;
  const data = (audio as { data?: unknown }).data;
  const url = (audio as { url?: unknown }).url;
  return {
    ...(typeof data === "string" ? { data } : {}),
    ...(typeof url === "string" ? { url } : {})
  };
}

async function alibabaBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  voice: string
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(DASHSCOPE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.value}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ALIBABA_MODEL,
        input: { text, voice, language_type: "Chinese" },
        parameters: { format: "mp3" },
        stream: false
      })
    });
  } catch {
    throw new SpeechGatewayError("provider-rejected", providerDiagnostic({ provider: "alibaba", voice }, "network"));
  }
  if (!response.ok) throw await httpProviderRejection(response, { provider: "alibaba", voice });

  let body: unknown;
  let responseMeta: ReturnType<typeof responseDiagnostic> = responseDiagnostic(response);
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseMeta = responseDiagnostic(response, encoded.byteLength);
    body = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response", responseMeta));
  }
  const audio = providerAudio(body);
  if (!audio) throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response", responseMeta));
  let bytes: Uint8Array | undefined;
  if (audio.data) bytes = base64ToBytes(audio.data);
  if ((!bytes || bytes.length === 0) && audio.url) {
    try {
      const url = new URL(audio.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
      const audioResponse = await fetchImpl(url.toString(), { method: "GET" });
      if (!audioResponse.ok) throw new Error("status");
      const contentType = typeof audioResponse.headers?.get === "function" ? audioResponse.headers.get("content-type") : "";
      if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new Error("content-type");
      bytes = await readBoundedResponse(audioResponse, MAX_AUDIO_BYTES);
    } catch {
      throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response"));
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
    throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "alibaba", voice }, "provider-response"));
  }
  return bytes;
}

interface ByteDanceFrame {
  code: number;
  data?: string;
}

type ByteDanceResponseIssue = NonNullable<SpeechFailureDiagnostic["responseIssue"]>;
type ByteDanceFrameResult =
  | { ok: true; frames: ByteDanceFrame[] }
  | { ok: false; issue: Exclude<ByteDanceResponseIssue, "read-failed"> };

function asFrame(value: unknown): ByteDanceFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const header = typeof record.header === "object" && record.header !== null && !Array.isArray(record.header)
    ? record.header as Record<string, unknown>
    : undefined;
  if ("code" in record && typeof record.code !== "number") return undefined;
  if ("data" in record && record.data !== null && typeof record.data !== "string") return undefined;
  if ("message" in record && typeof record.message !== "string") return undefined;
  if (header && "code" in header && typeof header.code !== "number") return undefined;
  if (header && "message" in header && typeof header.message !== "string") return undefined;
  const code = typeof record.code === "number" ? record.code : typeof header?.code === "number" ? header.code : undefined;
  const data = typeof record.data === "string" ? record.data : undefined;
  if (code === undefined) return undefined;
  return { code, ...(data === undefined ? {} : { data }) };
}

/** Parse the domestic one-shot endpoint's SSE `data:` frames. */
function parseByteDanceFrames(text: string): ByteDanceFrameResult {
  const frames: ByteDanceFrame[] = [];
  let sawData = false;
  for (const line of text.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) continue;
    if (item.startsWith(":") || item.startsWith("event:") || item.startsWith("id:") || item.startsWith("retry:")) continue;
    if (!item.startsWith("data:")) return { ok: false, issue: "invalid-frame" };
    const json = item.slice("data:".length).trim();
    if (!json || json === "[DONE]") continue;
    sawData = true;
    try {
      const frame = asFrame(JSON.parse(json));
      if (!frame) return { ok: false, issue: "invalid-frame" };
      frames.push(frame);
    } catch {
      return { ok: false, issue: "invalid-json" };
    }
  }
  return frames.length > 0
    ? { ok: true, frames }
    : { ok: false, issue: sawData ? "invalid-frame" : "no-data-frames" };
}

async function bytedanceBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  voice: string
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(BYTEDANCE_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "X-Api-Key": credential.value,
        "X-Api-Resource-Id": BYTEDANCE_RESOURCE_ID
      },
      body: JSON.stringify({
        user: { uid: "kepos-speech" },
        req_params: {
          text,
          speaker: voice,
          audio_params: { format: "mp3", sample_rate: 24_000 }
        }
      })
    });
  } catch {
    throw new SpeechGatewayError("provider-rejected", providerDiagnostic({ provider: "bytedance", voice }, "network"));
  }
  if (!response.ok) throw await httpProviderRejection(response, { provider: "bytedance", voice });

  let parsed: ByteDanceFrameResult | { ok: false; issue: "read-failed" };
  let responseMeta: ReturnType<typeof responseDiagnostic> = responseDiagnostic(response);
  try {
    const encoded = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    responseMeta = responseDiagnostic(response, encoded.byteLength);
    parsed = parseByteDanceFrames(new TextDecoder().decode(encoded));
  } catch {
    parsed = { ok: false, issue: "read-failed" };
  }
  if (!parsed.ok) throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic(
    { provider: "bytedance", voice },
    "provider-response",
    { ...responseMeta, responseIssue: parsed.issue }
  ));

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const frame of parsed.frames) {
    if (frame.code === 0) {
      if (frame.data !== undefined) {
        const bytes = base64ToBytes(frame.data);
        if (!bytes || total + bytes.length > MAX_AUDIO_BYTES) {
          throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "bytedance", voice }, "provider-response", responseMeta));
        }
        if (bytes.length > 0) {
          chunks.push(bytes);
          total += bytes.length;
        }
      }
      continue;
    }
    if (frame.code === 20_000_000) continue;
    throw new SpeechGatewayError("provider-rejected", providerDiagnostic(
      { provider: "bytedance", voice },
      "provider-response",
      responseMeta
    ));
  }
  if (total === 0) throw new SpeechGatewayError("provider-invalid-audio", providerDiagnostic({ provider: "bytedance", voice }, "provider-response", responseMeta));
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function providerBytes(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  text: string,
  profile: SpeechProfile
): Promise<Uint8Array> {
  return profile.provider === "bytedance"
    ? bytedanceBytes(fetchImpl, credential, text, profile.voice)
    : alibabaBytes(fetchImpl, credential, text, profile.voice);
}

const ASR_DIAGNOSTIC_PROFILE = { provider: "alibaba" as const, voice: QWEN_ASR_MODEL };

function asrDiagnostic(
  stage: NonNullable<SpeechFailureDiagnostic["stage"]>,
  detail: Pick<SpeechFailureDiagnostic, "httpStatus" | "responseContentType" | "responseBytes" | "requestId" | "responseIssue"> = {}
): Omit<SpeechFailureDiagnostic, "category"> {
  return providerDiagnostic(ASR_DIAGNOSTIC_PROFILE, stage, detail);
}

async function qwenAsrTranscription(
  fetchImpl: typeof fetch,
  credential: ResolvedCredential,
  request: ParsedTranscriptionRequest,
  signal?: AbortSignal
): Promise<KeposSpeechTranscription> {
  if (signal?.aborted) throw new SpeechGatewayError("cancelled");
  const encoded = bytesToBase64(request.data);
  const dataUrl = `data:${request.mediaType};base64,${encoded}`;
  if (dataUrl.length > MAX_ASR_DATA_URL_BYTES) throw new SpeechGatewayError("invalid-input");
  const asrOptions = {
    enable_itn: true,
    ...(request.language === undefined ? {} : { language: request.language })
  };
  let response: Response;
  try {
    response = await fetchImpl(DASHSCOPE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.value}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: QWEN_ASR_MODEL,
        input: {
          messages: [{
            role: "user",
            content: [{ audio: dataUrl }]
          }]
        },
        parameters: { asr_options: asrOptions },
        stream: false
      }),
      ...(signal === undefined ? {} : { signal })
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new SpeechGatewayError("cancelled");
    }
    throw new SpeechGatewayError("provider-rejected", asrDiagnostic("network"));
  }
  if (signal?.aborted) throw new SpeechGatewayError("cancelled");
  if (!response.ok) throw await httpProviderRejection(response, ASR_DIAGNOSTIC_PROFILE);

  let encodedResponse: Uint8Array;
  let responseMeta: ReturnType<typeof responseDiagnostic> = responseDiagnostic(response);
  try {
    encodedResponse = await readBoundedResponse(response, MAX_PROVIDER_JSON_BYTES);
    if (signal?.aborted) throw new SpeechGatewayError("cancelled");
    responseMeta = responseDiagnostic(response, encodedResponse.byteLength);
  } catch (error) {
    if (error instanceof SpeechGatewayError) throw error;
    if (signal?.aborted) throw new SpeechGatewayError("cancelled");
    throw new SpeechGatewayError("provider-invalid-transcription", asrDiagnostic("provider-response", {
      ...responseMeta,
      responseIssue: "read-failed"
    }));
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(encodedResponse));
  } catch {
    throw new SpeechGatewayError("provider-invalid-transcription", asrDiagnostic("provider-response", {
      ...responseMeta,
      responseIssue: "invalid-json"
    }));
  }
  try {
    return normalizeQwenAsrResponse(body);
  } catch {
    throw new SpeechGatewayError("provider-invalid-transcription", asrDiagnostic("provider-response", {
      ...responseMeta,
      responseIssue: "invalid-transcription"
    }));
  }
}

/** Shared in-flight work survives individual gateway instances and renderer disposal. */
const inFlight = new Map<string, Promise<number>>();

export class SpeechGateway {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SpeechGatewayOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async generateAndCache(path: string, text: string, profile: SpeechProfile): Promise<number> {
    // This disk check wins a race with another process that published the same
    // deterministic artifact while this request was being scheduled.
    const existing = await readAudioArtifactMetadata(path, MAX_AUDIO_BYTES);
    if (existing) return existing.size;
    const credential = await this.options.credentials.resolve(credentialRef(profile.credentialRef));
    if (!credential?.value) throw new SpeechGatewayError("unavailable", providerDiagnostic(profile, "credential"));
    const bytes = await providerBytes(this.fetchImpl, credential, text, profile);
    await writeAudioArtifactAtomic(path, bytes, MAX_AUDIO_BYTES);
    return bytes.byteLength;
  }

  private async artifact(path: string, text: string, profile: SpeechProfile): Promise<number> {
    const pending = inFlight.get(path);
    if (pending) return pending;
    // Keep the in-flight entry from the initial disk lookup onward. This
    // closes the small race where identical callers both observe a miss before
    // either provider request has started.
    const generation = this.generateAndCache(path, text, profile);
    inFlight.set(path, generation);
    generation.then(
      () => {
        if (inFlight.get(path) === generation) inFlight.delete(path);
      },
      () => {
        if (inFlight.get(path) === generation) inFlight.delete(path);
      }
    );
    return generation;
  }

  private async resolveArtifact(payload: unknown, signal?: AbortSignal): Promise<{
    request: KeposSpeechSynthesisRequest;
    digest: string;
    path: string;
    size: number;
  }> {
    if (signal?.aborted) throw new SpeechGatewayError("cancelled");
    const request = requestFromPayload(payload);
    const settings = this.options.getSettings();
    const profile = profileFromSettings(settings);
    const workspace = resolveSessionWorkspace(this.options.sessions, request.sessionId);
    if (!workspace) throw new SpeechGatewayError("unavailable", providerDiagnostic(profile, "session"));
    const digest = cacheDigest(request.text, settings, CACHE_FORMAT_VERSION);
    const path = audioArtifactPath(workspace, digest);
    // The provider request intentionally does not receive the caller signal:
    // once admitted, generation must finish so another occurrence can reuse it.
    const size = await this.artifact(path, request.text, profile);
    return { request, digest, path, size };
  }

  async synthesize(payload: unknown, signal?: AbortSignal): Promise<BrowserAudioPayload> {
    const { request, digest, size } = await this.resolveArtifact(payload, signal);
    return {
      mediaType: "audio/mpeg",
      url: audioUrl(request.sessionId, digest),
      bytes: size
    };
  }

  /**
   * Synthesize one bounded MP3 for an in-process Host consumer. The returned
   * value deliberately contains bytes only; browser URLs and cache paths stay
   * behind the Kepos-owned browser and filesystem seams.
   */
  async synthesizeBytes(payload: unknown, signal?: AbortSignal): Promise<KeposSpeechAudio> {
    try {
      const { path } = await this.resolveArtifact(payload, signal);
      const data = await readAudioArtifact(path, MAX_AUDIO_BYTES);
      if (!data) throw new SpeechGatewayError("internal");
      return { mediaType: "audio/mpeg", data };
    } catch (error) {
      if (error instanceof SpeechGatewayError) throw error;
      throw new SpeechGatewayError("internal");
    }
  }

  /**
   * Recognize one short voice attachment for a trusted Host consumer. The
   * operation deliberately bypasses speech provider selection: DashScope is the
   * sole ASR provider and always uses the shared Alibaba credential.
   */
  async transcribe(payload: unknown, signal?: AbortSignal): Promise<KeposSpeechTranscription> {
    try {
      if (signal?.aborted) throw new SpeechGatewayError("cancelled");
      const request = transcriptionRequestFromPayload(payload);
      const workspace = resolveSessionWorkspace(this.options.sessions, request.sessionId);
      if (!workspace) throw new SpeechGatewayError("unavailable", asrDiagnostic("session"));
      // Resolve this for every admitted call; credentials are intentionally not
      // cached and the selected speech provider never changes this reference.
      const credential = await this.options.credentials.resolve(credentialRef(ALIBABA_CREDENTIAL_REF));
      if (!credential?.value) throw new SpeechGatewayError("unavailable", asrDiagnostic("credential"));
      return await qwenAsrTranscription(this.fetchImpl, credential, request, signal);
    } catch (error) {
      throw reportGatewayFailure(error, this.options.onFailure);
    }
  }

  async handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<BrowserAudioPayload>> {
    if (endpoint !== RPC_ENDPOINT) return failure("invalid-input");
    try {
      return { ok: true, value: await this.synthesize(payload, signal) };
    } catch (error) {
      return failure(reportGatewayFailure(error, this.options.onFailure).category);
    }
  }
}

export function createSpeechRpcHandler(gateway: SpeechGateway): ConnectionRpcHandler {
  return (endpoint, payload, signal) => gateway.handle(endpoint, payload, signal);
}

/** Build the optional Cordis Host service from the shared gateway. */
export function createKeposSpeechService(gateway: SpeechGateway): KeposSpeechService {
  return {
    synthesize: (request, signal) => gateway.synthesizeBytes(request, signal),
    transcribe: (request, signal) => gateway.transcribe(request, signal)
  };
}

export function registerSpeechRpc(
  connection: Pick<HostConnectionRpc, "handle">,
  gateway: SpeechGateway
): () => Promise<void> {
  return connection.handle(RPC_CHANNEL, createSpeechRpcHandler(gateway));
}
