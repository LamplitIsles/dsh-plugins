# dsh-companion

`@lamplitisles/dsh-companion` is a small, one-to-one Svelte surface for DeepSeek Harness (DSH). It keeps DSH's durable Workspace/Session contracts and adds a calm chat presentation at `/companion/`.

This package is published independently from the
[`LamplitIsles/dsh-plugins`](http://forgejo.localhost:17480/LamplitIsles/dsh-plugins)
workspace. Its optional voice integration is provided by the separately
installed `@lamplitisles/dsh-speech` plugin.

## Install and build

From the workspace root, use Node.js `>=24.11.0` and the pinned pnpm 12.3.4 toolchain:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/dsh-companion run typecheck
corepack pnpm --filter @lamplitisles/dsh-companion run test
corepack pnpm --filter @lamplitisles/dsh-companion run build
```

The publishable package contains the Host bundle, the browser bundle, the Cordis patch, declarations, and this README. To install a local build into a disposable or real DSH profile, pack it and use DSH's plugin manager:

```sh
corepack pnpm --filter @lamplitisles/dsh-companion run build
corepack pnpm --filter @lamplitisles/dsh-companion pack --pack-destination /tmp/dsh-artifacts
dsh plugin --profile web add /tmp/dsh-artifacts/lamplitisles-dsh-companion-0.1.0.tgz
```

The package is pinned to the published DSH `0.1.2-rc.1` contract family (Cordis `4.0.2`). It is intentionally not a compatibility layer for other DSH releases. Session-derived behavior reads the rc.1 snapshot API; older eager event-array contracts are not supported.

## Two surfaces

- `/` remains the stock DSH Web UI, including advanced navigation, ordinary Tool views, Kepos ImageGen's React view, and plugin settings.
- `/companion/` selects the lower-priority Companion root. On each full-page entry it opens the **最新对话**: the most recently active eligible conversation in the configured Workspace, including human-created forks and excluding archived, foreign, and subagent sessions. Its conversation drawer lists those sessions for explicit switching without letting later background activity change the current choice. It also shows human and assistant chat, allowlisted ImageGen images, and finalized DSH Speech voice messages. A small **高级 DSH** link returns to `/` with a full-page navigation so the two compositions do not leak into one another.
- The stock DSH `/` surface contributes an **Open Companion** entry in its frame-wide top-right overlay. It performs a full-page navigation to `/companion/`, so the advanced surface's selected conversation is not transported into the independent Companion composition.
- The Companion avatar opens a right-side relationship drawer with the current state and newest-first Workspace-owned changes. Each change keeps only the dimensions and reasons recorded for that state update; the drawer can load earlier records without changing relationship state.
- Companion Markdown renders `\(...\)`, `\[...\]`, `$$...$$`, and supported single-dollar inline math with locally bundled KaTeX assets. Raw HTML stays unsupported, malformed expressions remain non-fatal, and long display formulas scroll within their message bubble.

Typing `/compact` as the complete Companion input invokes DSH's Session command channel and keeps the continuity checkpoint invisible; other slash-prefixed text remains an ordinary message.

Messages sent during a reply use DSH's durable FIFO queue and remain separate turns. With an empty draft, the composer action stops the current reply without clearing queued messages; DSH resumes those messages in order after cancellation settles.

The ordinary-send optimistic echo, request/RPC identity model, Session-to-Chat handoff, failure restoration, image ownership, and regression strategy are documented in [Optimistic message sending and visual continuity](docs/optimistic-message-sending.md).

DSH continues to stream and persist model output internally, while Companion shows assistant text only after its message is finalized. The typing bubble gains a slowly rotating, non-repeating companion note after a 12-second wait; stopping or completing the reply clears that transient timer state.

While ImageGen is running, its image skeleton and “正在画一张图…” status replace the generic typing bubble. If the agent resumes text generation after the image settles, the typing indicator returns with a fresh long-wait timer.

The Companion deliberately does not include a Workspace picker or new-chat creation flow, model or preset controls, permissions/approvals, reasoning, Trajectory, generic Tool cards, prompt-injection inspection, generic file upload, notifications, or multi-contact UI. It does include a read-only session list for the configured Workspace and supports image messages through DSH's Session attachment contract plus one short voice-input control in the composer.

## Configuration and recovery

Open the native DSH plugin settings page on `/` and configure:

- one stable Workspace id;
- Companion and user display names;
- an optional bounded local avatar for each identity (PNG/JPEG/WebP/GIF, at most 5 MB, decoded dimensions at most 4096 px);
- the user's preferred form of address; and
- the default affinity for a new or explicitly reset relationship (integer 0–100).

The configured Workspace is resolved by id and the live Session cwd. A missing id, stale Session, failed open, send rejection, or lost connection is shown as a recovery state; the Companion never silently selects another Workspace. The settings card keeps staged edits after a rejected/conflicted write and provides native Discard/Save actions. Editing the default affinity does not rewrite an established relationship.

Mood, affinity, and signature are Host-owned state stored as append-only records under the configured Workspace at `.dsh/dsh-companion/state.jsonl`. Each successful change adds one timestamped complete state; the newest record drives the UI and Agent context, while earlier notes and per-field reasons remain available as relationship history. Session logs are not the runtime state authority. Tests use only test-owned state and never mutate a live Workspace. The Host validates and bounds every load and mutation. The Companion exposes only a read-only relationship RPC to the browser; the agent's `companion_update_relationship` Tool atomically changes mood, affinity, or both, while `companion_set_signature` independently changes its durable signature. `companion_read_history` deliberately validates the full bounded JSONL and returns 1–20 recent records newest first without mutation; history is never injected automatically into every turn. All three Tools remain hidden from the chat timeline. Cross-field and numeric bounds are enforced by Host TypeScript rather than advanced provider-facing JSON Schema. Affinity movement is clamped to ±10 net per accepted turn, and the dynamic prompt context is bounded descriptive metadata—not instructions, permissions, or a score to maximize.

For Sessions in that configured Workspace only, the package replaces DSH basic compaction's final instruction with its fixed companion continuity checkpoint. Other Sessions and LLM calls are unchanged. A request that is otherwise eligible but no longer has DSH basic compaction's expected final message fails visibly, rather than applying the companion prompt to an unknown backend; the runtime instruction is the single source of truth for its wording.

The execution posture is fixed to `workspace-write` with escalation disabled. Operations requiring broader authority fail; no approval or permission picker is presented.

## Media dependencies

Images use the selected DSH Session attachment contract. Only assistant structured image blocks and successful/running/failed `kepos_image_generate` results are projected; unrelated Tool output is hidden. Object URLs are page-owned and revoked when replaced or unloaded. The stock `/` ImageGen renderer remains untouched.

Voice rows recognize exactly one finalized `[[tts:text]]...[[/tts:text]]` passage (fenced code and malformed/multiple passages are ignored; normalized text is limited to 240 Unicode code points). Synthesis calls the already-installed DSH Speech `synthesize` RPC on `/dsh-speech` with the live Session id. The returned audio URL must remain on the same-origin `/dsh-speech/audio/` route. A page-local cache shares preparation by Session and normalized text, requires user activation for playback, and always leaves a transcript fallback. Install DSH Speech alongside Companion when voice output or input is needed.

The composer microphone sits immediately left of the context-capacity circle. Click **开始录音** to request microphone access and click **结束录音** to stop; the browser stops automatically at five minutes or before the provider's complete `data:<mediaType>;base64,...` payload reaches its 10 MiB bound. The exact raw-byte ceiling depends on the normalized emitted media type (its prefix is part of that bound). Voice input requires a secure browser context, `MediaRecorder`, the installed DSH Speech plugin's optional `dshSpeech.transcribe` Host capability, and its shared DashScope credential (`DSH_SPEECH_DASHSCOPE_API_KEY`). The recording is held only long enough to send its Base64 bytes through Companion's authenticated Host RPC, is transcribed, and is then discarded: Companion writes no `localStorage` entry, workspace file, audio cache, player, attachment, or provider credential. A successful transcript is submitted as one ordinary Session text turn prefixed with `🎙️ `; when DSH Speech supplies a recognized expression label, only its raw bracketed form (for example `[sad]`) is appended. Missing or unknown labels are omitted. The marker and bracketed label are model-readable voice metadata, not transcript content or a claim about the speaker's inner state. Typed sending remains available while **正在转写语音…** is shown, and a failed or empty attempt creates no turn.

## Themes and device target

DSH's effective appearance is the only theme authority: light maps to the authored **Sticker Messenger** palette and dark maps to **Night Voyage**. The root updates in place on `theme/change`; it does not write a second preference or remount the timeline. Tailwind Preflight is omitted, utilities/components are prefixed, and Companion selectors are rooted at `#dsh-companion`, leaving `/` untouched.

The committed fixture and Playwright project cover desktop and Pixel 7a-sized Chromium geometry (412×915 CSS px, DPR 2.625, mobile UA/touch), including reduced-height composer behavior, IME/newline handling, scroll anchoring, overlays/Back, media states, both themes, and reduced motion. This is a **Pixel 7a-sized Chromium behavior** claim, not exhaustive physical-device certification.

## Verification

The local acceptance commands are:

```sh
corepack pnpm --filter @lamplitisles/dsh-companion run typecheck
corepack pnpm --filter @lamplitisles/dsh-companion run test
corepack pnpm --filter @lamplitisles/dsh-companion run test:e2e
corepack pnpm run pack:check
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-companion run pack-smoke
```

`pack:check` builds and inspects every workspace tarball. The package
`pack-smoke` uses an explicitly supplied rc.1 CLI, a disposable `DSH_HOME`,
and a fake LLM to verify the packed Host/Loader contract. It does not touch a
live profile. A real browser/device deployment is an operator action outside
this local acceptance path.

## Independent release

Select this public package and an exact matching tag from the workspace root:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-companion v0.1.0 .release-artifacts/dsh-companion
```

The command validates metadata, packed files, expanded peer versions, and the
real packed Host gate before writing the tarball. Publication is separate and
manual; after reviewing the artifact, use existing npm credentials only at the
registry boundary:

```sh
npm publish .release-artifacts/dsh-companion/lamplitisles-dsh-companion-0.1.0.tgz \
  --access public --tag latest
```

Stable and prerelease versions remain independent package decisions. Use `og`
for Forgejo operations; this repository does not provision publishing trust or
credentials.
