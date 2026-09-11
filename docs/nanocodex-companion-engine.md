# Nanocodex engine for DSH Companion

Status: implementation delivered on 2026-09-10. The isolated packed Host gate
passes; rendered acceptance against the separately provisioned dev Host remains
an Owner task-scoped operational gate.

The [architecture decision](adr/0001-nanocodex-companion-engine.md) keeps the existing DSH Companion application and replaces its execution engine with our nanocodex fork through Node/WASM. This document owns the cross-repository integration design. Product terms remain in the [Companion glossary](../packages/dsh-companion/CONTEXT.md).

## Product decisions

- Keep DSH as the application host and retain the existing Companion UI and business integrations.
- Use nanocodex as the sole engine for the selected DSH profile, including the advanced DSH surface. Do not retain a second engine or workspace-based fallback.
- Continue existing conversations with their context. A fresh-session cutover, archived-only history, or silent context reset is not acceptable.
- Preserve the fork's existing Codex-aligned request, tool, and context behavior. This does not claim complete equivalence with every Codex feature.
- Use nanocodex's Code Mode runtime and QuickJS WASM evaluator for model-written JavaScript. Existing DSH plugin tools still execute through the DSH Host tool pipeline.
- Maintain a reusable isolated dev Host. The current DSH instance becomes staging and is updated deliberately after dev acceptance.

## Two implementation owners

- **`LamplitIsles/nanocodex`:** provide the accepted Node/WASM resolver and
  exact compaction-outcome contract while retaining its Rust compaction
  implementation, Code Mode runtime, and QuickJS evaluator.
- **This repository:** add the DSH engine plugin; own its Cordis factory, input
  and tool bridge, event projection, configuration binding, session/checkpoint
  integration, live-runtime compaction mapping, and durable DSH projection.
  Companion keeps its original middleware and product-owned instruction.

The package is `@lamplitisles/dsh-nanocodex`, owned by
`packages/dsh-nanocodex`. It is a public workspace package with an independent
`0.1.0` version. Development consumes the sibling Nanocodex checkout.
The original engine merge landed at
`3dc3910af5ccb17d62f664dc03ea11789de339fd`; this historical revision is not the
runtime packed by the current artifact. The accepted host-compaction artifact
is built from sibling source `32f5f6e4031040f4b7fac7aefd2a64d7d4baedf2` against
baseline `e855ab2329a41824bf2d486bb0f259003f4f605d`. Its Nanocodex `0.5.0`
tarball SHA-256 is
`8b8fbab2d0ec68de9a7f09d050c8ddd388f6b3e59a2de71b0dca573823bcccf0`, and its
generated pkg-web WASM SHA-256 is
`1c56d2a6439f292761f112b17c79245b33d8cf9c3c5244faeb717106a8271c4e`.
`prepack` vendors this runtime and the `nanocodex-tools` `0.1.0` closure into
the packed artifact; the sibling checkout is a development-time source and
packing input only.

Business code remains with its current DSH plugin owner. Bind existing mail, tabletop, memory, relationship, and image-generation capabilities instead of copying their implementations into the engine plugin. Keet stays under its existing repository ownership; adding new communication features is separate from proving the engine replacement.

There is no new MCP endpoint or Rust-to-Node network RPC between the engine and DSH. The supported Node/WASM host bindings provide in-process calls. Existing integrations may continue using their own necessary transports.

## Host and execution boundary

The installed workspace declarations for DSH `0.1.2-rc.1` expose `AgentFactory.createAgent`, `AgentFactory.resume`, and `AgentRegistry.setFactory`. Start from this contract family, which this workspace and the current staging installation select. The newer DSH checkout is reference material, not permission to use newer APIs or upgrade the Host silently.

Factory registration is exclusive. Replace the default loop in the selected composition rather than racing two registrations. DSH owns the application lifecycle; nanocodex owns the agent's model loop. Do not register a complete nanocodex agent as an LLM provider underneath the old DSH loop.

Nanocodex's Node host accepts a `codeEvaluator` and exports `createQuickJsEvaluator`. Supply the existing QuickJS WASM implementation. Do not reimplement `exec`, output helpers, cell state, or tool scheduling in the adapter. Translate DSH's supported tool capabilities into the engine's model-facing definitions, then dispatch the actual operation through the appropriate DSH session and tool context.

QuickJS does not supply DSH authorization. Tool calls must retain the correct workspace identity, credentials, cancellation signal, output handling, and execution policy. Default Node handlers must not bypass DSH's filesystem and tool guards. Automatic recall and incoming communication events are application operations, not tools exposed merely because they cross a host binding.

DSH's provider, request-hook, and basic-compaction paths are not automatically invoked by another engine. Inventory the selected profile's hook consumers and assign each retained behavior to one owner. Nanocodex's compaction instruction resolver enters DSH's existing `llm/stream` waterfall with a final `dsh-compaction-basic` marker and an empty downstream stream; the original Companion middleware therefore selects its product-owned continuity instruction without a second model generation. The adapter's generic instruction is used for non-Companion sessions. Retire obsolete provider/code-mode/basic pressure owners from the selected composition rather than keeping parallel implementations for them.

Resolve model settings and credentials through DSH-owned services, without a second settings UI, application TOML file, or secret store. Map the selected GPT route deliberately; unsupported routes must fail clearly rather than silently switching engines. Codex-aligned execution behavior is preserved independently of the discarded native-TUI application plan.

## Existing conversations and durable recovery

DSH persists the authoritative transcript. The adapter is permanent and bidirectional: DSH input and restored active context become nanocodex input; nanocodex output, tool activity, and context replacements become DSH session events throughout every conversation. This is not a one-time history converter.

The engine's current model context is derived from that session's active
conversation surface and its DSH compaction checkpoint when one exists. There
must not be two independently authoritative writable conversation stores. The
adapter does not add a separate Nanocodex transcript writer.

WASM does not directly access the operating system filesystem, but a JavaScript host can provide filesystem and persistence callbacks. Nanocodex already uses such host bindings. DSH ownership is an explicit application decision, not a claim that WASM cannot participate in persistence.

### Existing nanocodex persistence interfaces

Nanocodex exposes opaque durability and completed-turn snapshot APIs. The
adapter associates each successful snapshot with DSH's public event log by
appending a versioned `nanocodexCheckpoint` field to `request/context` and
awaiting the official session flush. The record contains the provider/model,
snapshot, and an exact active-surface boundary: replacement generation, ordered
surface sequence numbers, message count, and a SHA-256 message fingerprint.
There is no private sidecar or second transcript. Recovery uses the
DSH-owned event log as the durable association:

- `Session.deriveMessages()` supplies the current active surface, including
  prior replacements.
- Nanocodex receives that projection through its typed `historySeed` on each
  model turn. A checkpoint is passed to the public `resume` API only when its
  route, model, surface generation, sequence prefix, message count, and
  fingerprint match; invalid, stale, or rejected checkpoints fall back to the
  current active surface, so opaque engine state cannot replace newer DSH facts.
- A successful Nanocodex compaction is represented by the existing DSH
  compaction events and private checkpoint message; the summary never becomes
  assistant text or an expandable card.
- Manual and automatic custom replacements use the current live Nanocodex
  runtime. The adapter consumes each `model.compaction.replaced` outcome once,
  maps its exact retained item identities to the DSH surface, and replaces the
  prefix before the latest real user-led tail. The public `compactRegion`
  surface accepts only that current prefix; arbitrary middle ranges fail with
  a `changed` error before model or surface mutation.
- `SessionPersistence` remains responsible for awaited append/flush and its
  official interrupted-turn recovery behavior.

This means restart continuity combines an associated opaque engine checkpoint
with semantic active-history hydration. The checkpoint is an optimization over
the authoritative DSH surface, not a replacement for it; response/cache
continuation is never required for correctness. Stronger exactly-once tool
execution across arbitrary crash windows remains outside this adapter.

### Continuous translation and resume

On first opening an existing DSH session through the new engine:

1. Read the supported DSH session projection, including previous context replacements. Do not feed the complete raw event log to the model or restore content intentionally removed from the active context by prior compaction.
2. Map its active messages, instructions, continuity summary, retained tool calls/results, and supported attachments into nanocodex's typed model input. Preserve call/result identities and their ordering. Historical tool calls are data; never execute them to reconstruct history.
3. Hydrate nanocodex through its public `historySeed` interface. The current
   `SessionSnapshot` fields are private engine state; the adapter does not
   fabricate one from serialized implementation details.
4. Keep the DSH session identity and conversation record. The first resumed provider request can replay the mapped active context without reusing a provider continuation ID; semantic continuity is required, reuse of a connection/cache identifier is not.

The same translation boundary is used during subsequent input, execution, compaction, and resume. It is part of the normal replacement adapter, not a separate bulk data migration or an optional legacy compatibility subsystem. Existing application data must not be rewritten merely to make the new engine load it. Unsupported retained content must be reported explicitly instead of being silently dropped.

The DSH event log is the persisted checkpoint for this adapter because it is the
only public rc.1 storage contract that can be associated with the exact session
boundary. Recovery preserves official DSH's conversation and completed-tool
guarantees; it does not promise exactly-once execution across every crash
window.

Compaction changes active model context, not the human-readable conversation. Its private 连续性摘要 must never become a visible assistant reply or expandable summary card. Failed or canceled compaction must preserve the last committed engine state and must not publish a successful 整理记录.

## Retained Companion behavior

- Preserve `/companion/` and the advanced DSH surface. Host output streams for event consumers; Companion continues to show assistant text after finalization.
- Messages submitted during a reply remain separate FIFO turns. Stopping the current reply preserves queued messages and allows them to continue after cancellation settles.
- Preserve the private continuity policy, non-expandable 整理记录, relationship state, and image/voice presentation used by the retained application.
- Preserve existing settings, credential ownership, and the configured workspace. Model selection and session controls must operate on the one selected engine, not on a dormant default loop.
- Preserve the existing execution posture and DSH tool guards.
- A new TUI, scheduled wakeups, broad UI redesign, and a general-purpose multi-engine router are outside this change.

## Reusable dev and staging environments

The reusable official rc.1 executable is installed at
`/home/neil/.local/share/dsh-dev-runtime`, with DSH home
`/home/neil/.local/state/dsh-dev` and port `3081`. The current
`/home/neil/.local/state/dsh` web profile and `dsh.service` are staging; the
existing [deployment procedure](local-deployment.md) continues to govern that
environment.

The dev executable and dependency cache are reusable. Persistent dev sessions and
manual settings are distinct from automated-test state. Normal development
builds affected packages and uses the repository `dev:deploy` command to update
the existing profile and restart only `dsh-dev.service`; it does not provision
another DSH runtime, home, or profile. Tests do not install over or mutate the
installed executable, the persistent dev home, or staging, and ordinary tests
do not start a DSH instance. `artifact:smoke` remains an explicitly selected
release/packaging diagnostic with its own temporary Host state, not a routine
development or handoff prerequisite.

Use packed plugin and nanocodex artifacts through the real Loader to prove dependency closure, including the agent WASM, QuickJS WASM, and generated bindings. Use local `link:` or `file:` dependencies for initial integration, including required workspace dependencies. Neither repository requires npm publication; local tarballs are sufficient for packed-artifact checks. Local links can speed iteration but are not artifact acceptance. No globally installed dependency or sibling checkout may be required by the packed result.

Neither a merge nor completion of this design changes staging automatically.
The adapter implementation did not install, restart, or deploy staging.

## Working slices and acceptance

Build end-to-end slices. Reuse existing tests and add only checks for new runtime behavior, bindings, or artifact contracts.

1. **Engine and tool bridge:** the packed-loader smoke admits one input, runs
   Nanocodex WASM and QuickJS, invokes the isolated tabletop tool through DSH,
   and observes the expected event sequence with no default-loop request.
2. **Conversation ownership:** focused Agent tests cover FIFO stop-and-drain;
   the packed smoke covers factory publication, unload cleanup, and the shared
   DSH session boundary. Rendered Companion/advanced-surface acceptance remains
   an Owner browser gate.
3. **Existing-session continuation:** history tests cover prior compaction,
   complete tool pairs, supported images, and explicit rejection of unsupported
   retained reasoning. The adapter hydrates the active DSH surface without
   executing historical tools.
4. **Continuity and restart:** the packed smoke exercises Nanocodex's real
   automatic context compaction, exact DSH surface replacement, a flushed
   versioned engine checkpoint, a fresh Host resume, and a deliberately changed
   boundary that forces active-surface hydration instead of stale checkpoint
   reuse. Focused compaction tests cover failed and canceled summary attempts;
   rendered cold-host acceptance remains an Owner browser gate.
5. **Retained integration acceptance:** DSH system-prompt and tool seams are
   retained in the adapter; relationship/media behavior remains in its existing
   owners and is not claimed by this isolated engine smoke.

Run repository-required workspace checks at implementation handoff and real packed/Loader acceptance for packaging and Host changes. Reuse completed checks for unchanged contracts. Do not add tests for prompt wording, source shape, documentation, or pure deletion. Repeat heavy gates only when their inputs change.

## Resolved interview decisions

- **Existing staging conversation:** continue with its existing context; no fresh-session reset. History adaptation is part of correctly replacing the agent loop.
- **Engine scope:** one engine for the selected profile, including both UIs; no dual engine.
- **Transcript ownership:** DSH persists the authoritative transcript; the plugin continuously translates in both directions. WASM uses host callbacks, not an independent conversation store.

The adapter's record types, event mapping, binding signatures, dev ports, and test fixtures are implementation decisions. Investigate them against the pinned contracts rather than asking the user to design them. Reopen a product decision only if a discovered limitation would change visible behavior or prevent the accepted continuity requirement.

### Hosted transport fallback

The adapter supplies Nanocodex's public `Transport.openAi` options to the
ordinary Agent, manual compaction, and ancillary LLM paths. WebSocket remains
the initial transport. Nanocodex may switch to POST HTTPS/SSE only for an
eligible connection or other transport failure before response output/tool
execution; cancellation, authentication/validation failures, and failures
after output do not replay the request. SSE is sticky for the affected runtime.
The adapter does not add another model loop, provider switch, or user-facing
fallback setting.

The public `model.attempt.retrying` event is projected to the existing Host
logger as `dsh-nanocodex.transport` with only
`nanocodex.transport_fallback`, DSH session/request correlation,
`websocket_fallback`, the previous/next transport, and the reason. Raw event
payloads, credentials, headers, request bodies, prompts, provider errors, and
private continuity data stay out of Host diagnostics and Companion chat.

## Current implementation status

The DSH adapter is implemented in `packages/dsh-nanocodex`. The package
registers one rc.1 `AgentFactory`, replaces the selected default-loop rows,
bridges DSH tools into Code Mode/QuickJS, projects streaming and finalized
assistant/tool events, preserves queued cancellation, and owns compaction
surface replacement. It also consumes the accepted Nanocodex hosted fallback
policy in all three model entry paths and projects its sanitized fallback
diagnostic to the Host logger. The filtered packed smoke rejects WebSocket
upgrades, serves the actual WASM/QuickJS run over local HTTP/SSE, and checks
the DSH tool, continuation, compaction, ancillary, and diagnostic paths.
`@lamplitisles/dsh-tabletop` is used only as an isolated packed smoke
dependency. The obsolete native sidecar path is not part of this workspace
delivery.
