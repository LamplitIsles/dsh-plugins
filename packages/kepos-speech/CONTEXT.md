# Kepos Speech context

This glossary describes the ownership and boundaries of Kepos Speech's browser
and Host-facing synthesis and recognition paths.

## Language

**Tagged passage**:
The one finalized assistant passage enclosed by `[[tts:text]]` and
`[[/tts:text]]`. It is validated and normalized before synthesis; the tag is
audio-only and is never a provider or voice override.

**Browser speech path**:
The authenticated Connection RPC and same-origin audio route used by the DSH
browser. It returns a workspace-owned URL and keeps native `<audio>` playback
unchanged.

**Host Speech service**:
The optional in-process Cordis service named `keposSpeech`. A Host
plugin calls `synthesize({ sessionId, text }, signal?)` for bounded MP3 bytes,
or `transcribe({ sessionId, mediaType, data, language? }, signal?)` for a
short, non-real-time Qwen ASR result with audio-level language and expression
annotations. Both operations require a live session; the transcription path
uses the shared DashScope credential and returns no browser URL, filesystem
path, public HTTP route, or persisted artifact. The synchronous model does not
provide sentence timestamps.

**Live session**:
A DSH session that resolves to an absolute workspace cwd through the Host
session resolver. The session supplies both authorization context and the
workspace used for cache ownership.

**Workspace audio artifact**:
The deterministic, atomically written MP3 under
`.dsh/kepos-speech/audio/<sha256>.mp3`. Browser and Host synthesis share this
artifact and its bounded read contract.

**Provider profile**:
The normalized provider, provider model/resource identity, and Voice ID used
for one request and its cache key. Credentials are resolved separately and
never enter the profile identity or returned service value.

**Shared DashScope credential**:
`KEPOS_SPEECH_DASHSCOPE_API_KEY`, used by Alibaba TTS and the fixed
`qwen3-asr-flash` Host transcription operation. It is configured through the
write-only native settings card regardless of the selected TTS output provider;
the Volcengine credential remains ByteDance-TTS-only.

**Speech-expression label**:
An optional discrete audio-level label returned by Qwen's model. It is
model-derived speech-expression metadata, not a factual claim about a speaker's
inner state, diagnosis, or decision signal.
