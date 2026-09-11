import type { Context } from "@deepseek-ai/cordis";
import type { AgentEvent } from "nanocodex/node";

const FALLBACK_EVENT = "model.attempt.retrying";
const FALLBACK_ERROR_CLASS = "websocket_fallback";
const PREVIOUS_TRANSPORT = "responses_websocket_v2";
const NEXT_TRANSPORT = "responses_https_sse";
const REASONS = new Set([
  "upgrade_required",
  "transport_unavailable",
  "retry_exhausted",
]);
const MAX_CORRELATION_LENGTH = 128;

export interface TransportFallbackDiagnostic {
  readonly kind: "nanocodex.transport_fallback";
  readonly session_id: string;
  readonly request_id?: string;
  readonly error_class: typeof FALLBACK_ERROR_CLASS;
  readonly previous_transport: typeof PREVIOUS_TRANSPORT;
  readonly next_transport: typeof NEXT_TRANSPORT;
  readonly reason:
    | "upgrade_required"
    | "transport_unavailable"
    | "retry_exhausted";
}

function boundedCorrelation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_CORRELATION_LENGTH);
}

export function transportFallbackDiagnostic(
  sessionId: string,
  event: AgentEvent,
): TransportFallbackDiagnostic | undefined {
  if (event.type !== FALLBACK_EVENT) return undefined;
  const payload = event.payload;
  if (
    payload.error_class !== FALLBACK_ERROR_CLASS ||
    payload.previous_transport !== PREVIOUS_TRANSPORT ||
    payload.next_transport !== NEXT_TRANSPORT ||
    typeof payload.reason !== "string" ||
    !REASONS.has(payload.reason)
  ) {
    return undefined;
  }
  const reason = payload.reason as TransportFallbackDiagnostic["reason"];
  const requestId = boundedCorrelation(event.request_id);
  return {
    kind: "nanocodex.transport_fallback",
    session_id: boundedCorrelation(sessionId) ?? "unknown",
    ...(requestId === undefined ? {} : { request_id: requestId }),
    error_class: FALLBACK_ERROR_CLASS,
    previous_transport: PREVIOUS_TRANSPORT,
    next_transport: NEXT_TRANSPORT,
    reason,
  };
}

interface EventWatcher {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  off(): void;
}

interface EventSource {
  readonly events: {
    watch(): EventWatcher;
  };
}

/** Observe public Nanocodex fallback events and project only safe fields. */
export function observeTransportFallback(
  ctx: Context,
  sessionId: string,
  source: EventSource,
): () => void {
  const watcher = source.events.watch();
  const removeListener = watcher.onEvent((event) => {
    const diagnostic = transportFallbackDiagnostic(sessionId, event);
    if (diagnostic === undefined) return;
    try {
      ctx.logger("dsh-nanocodex.transport").info(diagnostic);
    } catch {
      // Diagnostics are supplementary and must not change model completion.
    }
  });
  return () => {
    removeListener();
    watcher.off();
  };
}
