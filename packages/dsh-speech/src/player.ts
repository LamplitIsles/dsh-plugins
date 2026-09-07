import { createElement, useEffect, useRef, useSyncExternalStore } from "react";

import type { BrowserAudioPayload } from "./rpc.js";
import { normalizeSpeechText } from "./parser.js";
import styles from "./client/speech.module.dshcss";

export type SpeechPlayerStatus = "idle" | "loading" | "ready" | "error";

export interface SpeechPlayerSnapshot {
  status: SpeechPlayerStatus;
  error?: string;
}

export interface SpeechRpcClient {
  /** Session identity is sent with the finalized passage, never a cache path. */
  synthesize(text: string, sessionId: string, signal?: AbortSignal): Promise<BrowserAudioPayload>;
}

export interface SpeechAudioPlayerProps {
  text: string;
  transcript?: string;
  /** Secret-free normalized provider profile identity from a ready Host Settings snapshot. */
  profileKey?: string | undefined;
  /** Framework-provided session identity used by the Host to resolve cwd. */
  sessionId: string;
  client: SpeechRpcClient;
  labels?: Partial<{ preparing: string; audio: string; failed: string }>;
  className?: string;
}

interface PreparationEntry {
  promise: Promise<BrowserAudioPayload>;
  payload?: BrowserAudioPayload;
}

interface CachedAudio {
  key: string;
  url: string;
}

const preparationCaches = new WeakMap<object, Map<string, PreparationEntry>>();

function cacheFor(client: SpeechRpcClient): Map<string, PreparationEntry> {
  let cache = preparationCaches.get(client as object);
  if (!cache) {
    cache = new Map();
    preparationCaches.set(client as object, cache);
  }
  return cache;
}

function preparationKey(text: string, profileKey: string | undefined, sessionId: string): string {
  return JSON.stringify([sessionId, profileKey ?? null, normalizeSpeechText(text)]);
}

function validPayload(payload: BrowserAudioPayload): BrowserAudioPayload {
  if (typeof payload !== "object" || payload === null || payload.mediaType !== "audio/mpeg" || typeof payload.url !== "string" || payload.url === "" || !Number.isSafeInteger(payload.bytes) || payload.bytes <= 0) {
    throw new Error("invalid-audio-payload");
  }
  return payload;
}

/** Drop page-memory preparation indexes (the durable workspace files remain). */
export function clearSpeechPreparationCache(client?: SpeechRpcClient): void {
  if (client) preparationCaches.delete(client as object);
}

/** Fetches tagged speech immediately while sharing page-level work by session/text/profile. */
export class SpeechPlayer {
  private snapshot: SpeechPlayerSnapshot = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private cached: CachedAudio | undefined;
  private currentKey: string | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly client: SpeechRpcClient) {}

  getSnapshot = (): SpeechPlayerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(snapshot: SpeechPlayerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  hasCached(text: string, profileKey: string | undefined, sessionId: string): boolean {
    return this.cached?.key === preparationKey(text, profileKey, sessionId);
  }

  preparedUrl(text: string, profileKey: string | undefined, sessionId: string): string | undefined {
    return this.hasCached(text, profileKey, sessionId) ? this.cached?.url : undefined;
  }

  /** Forget a stale workspace URL when the browser cannot load its media. */
  failAudioLoad(): void {
    if (this.disposed || !this.currentKey) return;
    cacheFor(this.client).delete(this.currentKey);
    this.cached = undefined;
    this.publish({ status: "error", error: "audio-load-failed" });
  }

  /** Seed a remounted player from resolved page memory without publishing a new state cycle. */
  hydrate(text: string, profileKey: string | undefined, sessionId: string): boolean {
    if (this.disposed || profileKey === undefined) return false;
    const key = preparationKey(text, profileKey, sessionId);
    const payload = cacheFor(this.client).get(key)?.payload;
    if (!payload) return false;
    this.currentKey = key;
    this.cached = { key, url: payload.url };
    this.snapshot = { status: "ready" };
    return true;
  }

  async prepare(text: string, profileKey: string | undefined, sessionId: string): Promise<void> {
    if (this.disposed) return;
    const normalized = normalizeSpeechText(text);
    const key = preparationKey(normalized, profileKey, sessionId);
    const generation = ++this.generation;
    this.currentKey = key;
    if (this.cached?.key === key) {
      if (this.snapshot.status !== "ready") this.publish({ status: "ready" });
      return;
    }

    const shared = profileKey !== undefined;
    const cache = shared ? cacheFor(this.client) : undefined;
    let entry = cache?.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => this.client.synthesize(normalized, sessionId, controller.signal))
        .then(validPayload);
      const created: PreparationEntry = { promise };
      entry = created;
      if (cache) {
        cache.set(key, created);
        promise.then(
          (payload) => {
            if (cache.get(key) === created) created.payload = payload;
          },
          () => {
            if (cache.get(key) === created) cache.delete(key);
          }
        );
      }
    }

    this.publish({ status: "loading" });
    try {
      const payload = await entry.promise;
      if (this.disposed || generation !== this.generation || this.currentKey !== key) return;
      this.cached = { key, url: payload.url };
      this.publish({ status: "ready" });
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.currentKey !== key) return;
      this.publish({ status: "error", error: error instanceof Error ? error.message : "synthesis-failed" });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.currentKey = undefined;
    // Do not abort or remove the shared request: its Host generation is
    // deliberately allowed to finish and populate the durable workspace cache.
    this.listeners.clear();
  }
}

export function SpeechAudioPlayer({
  text,
  transcript = text,
  profileKey,
  sessionId,
  client,
  labels,
  className
}: SpeechAudioPlayerProps) {
  const playerRef = useRef<SpeechPlayer | null>(null);
  if (!playerRef.current) {
    const player = new SpeechPlayer(client);
    player.hydrate(text, profileKey, sessionId);
    playerRef.current = player;
  }
  const player = playerRef.current;
  const preparationRef = useRef<{ text: string; profileKey: string | undefined; sessionId: string } | null>(null);
  if (!preparationRef.current) preparationRef.current = { text, profileKey, sessionId };
  const preparation = preparationRef.current;
  const snapshot = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  useEffect(() => {
    void player.prepare(preparation.text, preparation.profileKey, preparation.sessionId);
  }, [player, preparation]);
  useEffect(() => () => player.dispose(), [player]);

  const src = player.preparedUrl(preparation.text, preparation.profileKey, preparation.sessionId);
  const classes = [styles.player, className].filter(Boolean).join(" ");
  if (snapshot.status === "ready" && src) {
    return createElement(
      "div",
      { className: classes, "data-speech-state": snapshot.status },
      createElement("span", { className: styles.playerLabel }, labels?.audio ?? "Audio message"),
      createElement("audio", {
        controls: true,
        preload: "metadata",
        src,
        onError: () => player.failAudioLoad(),
        "aria-label": `${labels?.audio ?? "Audio message"}: ${transcript}`
      })
    );
  }
  if (snapshot.status === "error") {
    return createElement(
      "div",
      { className: classes, "data-speech-state": snapshot.status },
      createElement("span", { className: styles.transcript, "data-speech-transcript": true }, transcript),
      createElement("span", { className: styles.error, role: "status" }, labels?.failed ?? "Audio unavailable; transcript shown.")
    );
  }
  return createElement(
    "div",
    { className: classes, "data-speech-state": snapshot.status, "aria-busy": true },
    createElement("span", { className: styles.preparing, role: "status" }, labels?.preparing ?? "Preparing audio…")
  );
}
