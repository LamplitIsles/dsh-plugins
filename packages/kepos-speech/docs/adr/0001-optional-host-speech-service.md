# Optional Host Speech service

Date: 2026-09-04

## Status

Accepted

## Context

Kepos Speech already owns provider credentials, live-session validation, cache
identity, and bounded MP3 artifacts, but those capabilities were reachable
only through the browser Connection RPC. Another Host plugin should be able to
deliver trusted speech without routing through a browser transport or copying
provider integrations.

## Decision

The Kepos plugin publishes one optional Cordis service at `keposSpeech` while its
Host fiber is mounted. Its stable contract is:

```ts
interface KeposSpeechService {
  synthesize(
    request: { sessionId: string; text: string },
    signal?: AbortSignal
  ): Promise<{ mediaType: "audio/mpeg"; data: Uint8Array }>;
  transcribe(
    request: {
      sessionId: string;
      mediaType: string;
      data: Uint8Array;
      language?: string;
    },
    signal?: AbortSignal
  ): Promise<{
    text: string;
    language?: string;
    expression?: string;
  }>;
}
```

The service delegates to the existing `SpeechGateway`, so validation, session and
workspace resolution, provider and credential selection, deterministic cache
identity, provider invocation, and bounded artifact reads remain owned by
Kepos. It returns bytes only: consumers do not receive a browser URL or cache
path. Typed gateway failure categories remain the failure vocabulary, and no
provider diagnostic is placed in the service value.

The same optional service also exposes bounded, synchronous Qwen ASR for
short non-real-time audio. It resolves the shared DashScope credential on each
call, uses the fixed `qwen3-asr-flash` model, propagates cancellation, and
returns provider-neutral text plus the model's optional audio-level language
and speech-expression annotations. The synchronous response has no sentence
timestamps; provider-owned confidence and raw response fields are not part of
the contract.

The service is optional and is removed with the plugin lifecycle. Consumers
must read it with `ctx.get("keposSpeech")` and handle `undefined`; Kepos does not
inject consumers. The authenticated browser RPC and same-origin artifact route
use the Speech-named contract for browser tagged-TTS behavior.

## Consequences

Host consumers can upload or otherwise process one bounded MP3 without knowing
about Web transport or cache layout. Host consumers can likewise submit one
bounded audio clip for Qwen recognition without knowing DashScope request
details. The encoded Data URL is bounded to 10 MB, while DashScope enforces the
five-minute duration limit. Deployments without Kepos Speech expose no service,
while mounted deployments retain one provider and cache owner. This is an
in-process Host seam, not a public synthesis endpoint or a streaming audio API.
