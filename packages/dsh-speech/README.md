# DSH Speech

`@lamplitisles/dsh-speech` is a DeepSeek Harness Web plugin for Chinese
speech synthesis and short-audio recognition. It adds one optional audio-only
`[[tts:text]]...[[/tts:text]]` block to a finalized assistant reply, prepares
the resulting MP3, and replaces the block with the browser's native audio
player. The Host service also exposes bounded, synchronous Qwen ASR to trusted
in-process callers.

Locally transcribed user turns use a `🎙️ ` prefix and can end in a recognized
expression label such as `[neutral]`. The Speech system prompt defines both as
voice metadata: the marker identifies the source, and the label is an
audio-level ASR classification rather than message content or a claim about the
speaker's inner state.

Source: <http://forgejo.localhost:17480/LamplitIsles/dsh-plugins>.

## Install for DSH

```sh
dsh plugin --profile <profile> add @lamplitisles/dsh-speech
```

The package is pinned to the DSH `0.1.2-rc.1` contract family and contains the
Host entry, browser loader, and `cordis.patch.yml` bundle patch. The packed
smoke test requires `DSH_CLI` to point to an executable that reports exactly
`0.1.2-rc.1`; it uses only test-owned temporary state and never selects an
ambient runtime.

## Settings and providers

Open the native **DSH Speech** Plugin Settings card from a local loopback
DSH Web session and choose Alibaba or ByteDance for tagged TTS output. The
editable Voice IDs default to `Maia` and
`zh_female_sajiaoxuemei_uranus_bigtts`; provider-supported IDs up to 128
characters are accepted. The DashScope key is shared by Alibaba TTS and the
fixed Qwen ASR path. The Volcengine key is used only for ByteDance TTS. Both
credential fields are write-only and are stored by DSH as
`DSH_SPEECH_DASHSCOPE_API_KEY` and `DSH_SPEECH_VOLCENGINE_API_KEY`.

The provider selector controls TTS output only. Qwen ASR is the sole
recognition provider and accepts one non-empty supported audio attachment up to
the documented 10 MB encoded bound. It returns complete text and optional
audio-level language and speech-expression annotations; it does not persist
audio or transcript content.

## Optional Host service

When mounted, the plugin publishes the optional Cordis service
`ctx.get("dshSpeech")`. A Host plugin can consume the exported
`DshSpeechService` contract:

```ts
const speech = ctx.get("dshSpeech");
if (speech) {
  const audio = await speech.synthesize({ sessionId, text }, signal);
  // audio.mediaType === "audio/mpeg"; audio.data is bounded MP3 bytes

  const transcript = await speech.transcribe(
    {
      sessionId,
      mediaType: "audio/ogg",
      data: attachmentBytes,
      language: "zh",
    },
    signal,
  );
  // transcript.text plus optional language/expression annotations
}
```

The service validates the live session and shares the workspace cache with
browser TTS. It is optional, is removed with the plugin lifecycle, and is not a
public transcription or synthesis route. Browser synthesis uses the
authenticated `/dsh-speech/synthesize` RPC and same-origin
`/dsh-speech/audio/...` artifacts.

## Audio cache

Each prepared passage is keyed by normalized text, provider profile, and cache
format, then written atomically as
`.dsh/dsh-speech/audio/<sha256>.mp3` below the active session workspace. A
refresh or remount resolves the session again and reuses the bounded artifact;
there is no browsing, migration, eviction, or cache-management UI.

## Development and packed verification

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/dsh-speech run typecheck
corepack pnpm --filter @lamplitisles/dsh-speech run test
corepack pnpm --filter @lamplitisles/dsh-speech run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-speech run pack-smoke
```

The smoke test installs the packed artifact into a disposable DSH
`0.1.2-rc.1` Web profile, verifies Host RPC and Settings registration, and
loads the served client through the real Loader. It uses test-owned temporary
directories and never modifies a live profile, credential, or provider.

## Independent release

Prepare only this package and an exact matching tag from the workspace root:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-speech v0.1.0 .release-artifacts/dsh-speech
```

After reviewing the verified tarball, publish it separately with existing npm
credentials at the registry boundary:

```sh
npm publish .release-artifacts/dsh-speech/lamplitisles-dsh-speech-0.1.0.tgz \
  --access public --tag latest
```

Versions remain independent across the workspace. Release preparation does not
publish, deploy, or provision npm trust; use `og` for Forgejo operations.
