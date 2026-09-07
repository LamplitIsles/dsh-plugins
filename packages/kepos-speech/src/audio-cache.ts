import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { profileFromSettings, type SpeechProfile } from "./constants.js";
import { normalizeSpeechText } from "./parser.js";

/** Maximum provider payload accepted and maximum cached artifact served. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Bump when the on-disk key or artifact contract changes. */
export const CACHE_FORMAT_VERSION = 2;
export const SPEECH_CACHE_DIRECTORY = ".dsh/kepos-speech/audio";
export const AUDIO_ROUTE_PATH = "/kepos-speech/audio";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** The small session face needed by the cache; the concrete Host type stays private. */
export interface SessionResolver {
  get(sessionId: string): { header?: { cwd?: unknown } } | undefined;
}

/** Resolve the immutable workspace cwd carried by a live Host session. */
export function resolveSessionWorkspace(sessions: SessionResolver, sessionId: string): string | undefined {
  if (!sessionId || sessionId.length > 512) return undefined;
  let session: { header?: { cwd?: unknown } } | undefined;
  try {
    session = sessions.get(sessionId);
  } catch {
    return undefined;
  }
  const cwd = session?.header?.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
  return resolve(cwd);
}

/** Return the fixed cache directory below one validated workspace. */
export function audioCacheDirectory(workspaceCwd: string): string {
  return join(workspaceCwd, SPEECH_CACHE_DIRECTORY);
}

/** Return the artifact path for a digest, rejecting path-like names. */
export function audioArtifactPath(workspaceCwd: string, digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) throw new Error("invalid-audio-digest");
  return join(audioCacheDirectory(workspaceCwd), `${digest}.mp3`);
}

/**
 * Build the deterministic cache digest from the format, provider, provider
 * model/resource, voice, and normalized passage. JSON gives each field an
 * unambiguous boundary.
 */
export function cacheDigest(
  text: string,
  settings: unknown,
  formatVersion = CACHE_FORMAT_VERSION
): string {
  const profile: SpeechProfile = profileFromSettings(settings);
  const normalized = normalizeSpeechText(text);
  return createHash("sha256")
    .update(JSON.stringify([
      formatVersion,
      profile.provider,
      profile.model,
      profile.voice,
      normalized
    ]), "utf8")
    .digest("hex");
}

/** Build the same-origin URL a browser audio element can load. */
export function audioUrl(sessionId: string, digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) throw new Error("invalid-audio-digest");
  return `${AUDIO_ROUTE_PATH}/${digest}.mp3?sessionId=${encodeURIComponent(sessionId)}`;
}

/** Read a complete bounded regular artifact, treating an absent/invalid file as a miss. */
export async function readAudioArtifact(path: string, maxBytes = MAX_AUDIO_BYTES): Promise<Uint8Array | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined;
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return undefined;
  return bytes;
}

/** Return bounded metadata for a regular cached artifact without reading its contents. */
export async function readAudioArtifactMetadata(path: string, maxBytes = MAX_AUDIO_BYTES): Promise<{ size: number } | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return undefined;
  return { size: info.size };
}

/** Publish bytes without ever exposing a partially written destination. */
export async function writeAudioArtifactAtomic(path: string, bytes: Uint8Array, maxBytes = MAX_AUDIO_BYTES): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error("provider-invalid-audio");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export interface AudioResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: unknown): unknown;
}

function endResponse(res: AudioResponse, status: number, body = "not found", headers?: Record<string, string>): void {
  res.writeHead(status, headers);
  res.end(body);
}

function digestFromPath(pathname: string): string | undefined {
  const match = pathname.match(new RegExp(`^${AUDIO_ROUTE_PATH}/([a-f0-9]{64})\\.mp3$`));
  return match?.[1];
}

/**
 * Serve one digest-named artifact. The workspace is looked up again for every
 * request, so a URL cannot select an arbitrary filesystem directory.
 */
export async function serveSpeechAudio(
  req: Pick<IncomingMessage, "url" | "method">,
  res: AudioResponse,
  sessions: SessionResolver,
  maxBytes = MAX_AUDIO_BYTES
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    endResponse(res, 405, "method not allowed", { allow: "GET, HEAD" });
    return;
  }

  let request: URL;
  try {
    request = new URL(req.url ?? "/", "http://dsh.internal");
  } catch {
    endResponse(res, 404);
    return;
  }
  const digest = digestFromPath(request.pathname);
  const sessionId = request.searchParams.get("sessionId");
  if (!digest || !sessionId) {
    endResponse(res, 404);
    return;
  }
  const workspace = resolveSessionWorkspace(sessions, sessionId);
  if (!workspace) {
    endResponse(res, 404);
    return;
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = await readAudioArtifact(audioArtifactPath(workspace, digest), maxBytes);
  } catch {
    bytes = undefined;
  }
  if (!bytes) {
    endResponse(res, 404);
    return;
  }
  res.writeHead(200, {
    "content-type": "audio/mpeg",
    "content-length": String(bytes.byteLength),
    "cache-control": "public, max-age=31536000, immutable"
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(bytes);
}

export interface AudioRouteRegistrar {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** Register the plugin-owned same-origin cache route. */
export function registerSpeechAudioRoute(
  webServer: AudioRouteRegistrar,
  sessions: SessionResolver,
  maxBytes = MAX_AUDIO_BYTES
): () => void {
  return webServer.register({
    kind: "prefix",
    path: AUDIO_ROUTE_PATH,
    handler: (req, res) => serveSpeechAudio(req, res, sessions, maxBytes)
  });
}
