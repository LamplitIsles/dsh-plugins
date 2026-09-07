# Kepos Speech operator notes

This package is intended for a disposable or locally managed DSH Web bundle.
From the workspace root, build the package with Node.js/pnpm, run the
typecheck/tests, and inspect the packed client artifact before installing it
into a Web profile. Run the packed smoke with:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/kepos-speech run pack-smoke
```

It installs the tarball under a disposable test-owned `DSH_HOME`, starts the
installed DSH Web runtime on a test-owned loopback port, and verifies the real
Host patch, Settings registration, RPC route, and browser loader. It never
touches a live DSH profile or credential.

Configure Alibaba or ByteDance and its independent Voice ID from a local
loopback DSH Web Settings session. The defaults are `Maia` and
`zh_female_sajiaoxuemei_uranus_bigtts`, but Voice IDs are free-form (up to 128
characters). The DashScope key is always shown as a write-only field labelled
shared by Alibaba TTS and Qwen speech recognition, even when ByteDance is the
selected TTS provider. The Volcengine key is shown only for ByteDance TTS. DSH
stores DashScope under `KEPOS_SPEECH_DASHSCOPE_API_KEY` and ByteDance under
`KEPOS_SPEECH_VOLCENGINE_API_KEY`; there is no agenix or remote configuration
endpoint. The provider selector is TTS-only: Qwen ASR is the sole STT provider,
with no STT selector. An unavailable or memory-backed remote Settings scope does not
render this card; a ready non-writable Host scope is read-only. Tagged TTS
still reaches the Host in those scopes, but page-memory preparation sharing
starts only after a real ready Host profile exists. When a tagged message
completes, the browser immediately prepares its MP3 and replaces the tag with
the browser's native audio player. If synthesis fails, the transcript stays
visible.

While the plugin is mounted, Host consumers can optionally read
`ctx.get("keposSpeech")` and call `synthesize({ sessionId, text }, signal?)` for
one bounded `{ mediaType: "audio/mpeg", data: Uint8Array }` result. The
service shares the same validation, provider credentials, and workspace cache
as browser TTS, and disappears when the plugin is disposed. It never exposes a
browser URL or cache path and does not add a public synthesis route.

The same service exposes `transcribe({ sessionId, mediaType, data, language? },
signal?)`. It accepts one supported, non-empty audio `Uint8Array` whose Base64
Data URL is no larger than 10 MB and validates the live session before
resolving the shared DashScope key. It sends that private Data URL to
the synchronous `qwen3-asr-flash` endpoint and propagates cancellation.
DashScope enforces the five-minute duration boundary; Kepos deliberately does
not decode arbitrary containers to estimate it. The documented provider-neutral
value contains complete text plus optional audio-level detected language and a
discrete speech-expression label; this synchronous model does not provide
sentence timestamps. The label is model-derived speech-expression metadata,
not a psychological assessment or fact about the speaker. Audio, transcripts,
raw provider responses, and credentials are neither stored nor included in
failures or diagnostics. The service is the stable Speech-named Host seam;
Matrix and Companion adapters are not part of this package.

Artifacts live under the session's immutable workspace cwd at
`.dsh/kepos-speech/audio/<sha256>.mp3`. The digest includes the normalized passage,
provider, model/resource, Voice ID, and cache format. The Host validates the
session and digest again when serving `/kepos-speech/audio/<digest>.mp3?sessionId=...`,
so a client cannot select another workspace path. Cache writes are bounded and
atomic; a second request, another gateway instance, or a later page visit
reuses the matching provider artifact without another provider call. Remove
files manually only as part of workspace maintenance—the plugin intentionally
provides no cache-management surface.
