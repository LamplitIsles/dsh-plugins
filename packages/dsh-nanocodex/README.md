# DSH Nanocodex

This package replaces the selected DeepSeek Harness agent loop with the
Nanocodex Node/WASM engine. DSH remains the owner of session events, settings,
credentials, workspace policy, and tool execution; Nanocodex owns model
execution, Code Mode, QuickJS, and model-context compaction.

The workspace install hook downloads the Nanocodex SDK and tools from the
release pinned in `engine-release.json`, verifies their SHA-256 hashes, and
caches them under the repository's `.cache/nanocodex/`. The current handoff
pins the reviewed `v0.5.0-lamplit.2` proposal; its public URLs are not yet
published, so local verification uses the task-owned verified archives and a
clean-cache installation remains an Owner publication gate. Local development
and CI use these same archives without a sibling checkout. During packing,
`prepack` copies both archives into `vendor/`, rewrites their internal imports,
and removes the local dependency entries from the packed manifest. The packed
plugin includes the release pin and runs without downloading engine artifacts.
Source provenance is recorded in `docs/IMPORTS.md` and
`docs/nanocodex-companion-engine.md`.

## Supported route

The adapter accepts only the explicit OpenAI Responses route (`openai` or
`openai-codex-responses`) and the four Nanocodex model ids:
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-6-astra`.
The selected route's `apiKeyEnv` and optional `baseURL` are read from the
DSH-owned `llm-pi-ai` settings shape and its credential is resolved through
`ctx.credentials` for each engine creation. Unsupported routes fail before a
provider request. The adapter accepts only the named `openai` and
`openai-codex-responses` providers with an `openai`/`openai-responses` API.

## Tool surface

Nanocodex exposes the ordinary tools composed by the active DSH profile,
including DSH Bash, MCP, and delegation. Nanocodex's built-in subagent tools
are disabled so delegation remains DSH-owned. The package also registers the
DSH-authorized `apply_patch` tool as a raw custom model tool:

```text
*** Begin Patch
*** Add File: notes/example.txt
+new text
*** Update File: notes/existing.txt
@@
-old text
+new text
*** End Patch
```

Only `Add File` and `Update File` operations are supported. `Delete File` and
`Move to` are rejected. The patch parser and matcher are maintained in this
package, while the active DSH filesystem resolves paths, observes versions,
enforces workspace containment, and performs guarded writes. Historical patch
calls are hydrated as raw custom calls and are never executed again during
resume or compaction; their results retain diff metadata for the Host.

For local images, use DSH's official `read_image` tool and emit its adapted
Code Mode result:

```js
image(await tools.read_image({ file_path: "picture.png" }));
```

The Code Mode result contains only `path` and `image_url`; the DSH result
keeps its durable attachment reference. Call `image(result)` to emit the image;
a bare `return result` completes the script without emitting it. Reading images
through bash output is unnecessary and can truncate binary data.

At a stopped driver boundary, interrupted calls receive an explicit error
result. Agent activation also closes missing results left by an earlier failed
turn, preserving the original calls and completed child operations. Recovery
never re-executes tools or assumes their side effects were rolled back. A
projection failure retains its original cause instead of reporting only the
cancellation used to stop generation.

Existing sessions are continued from DSH's active surface through typed
`historySeed` hydration. Text-only reasoning blocks remain in the DSH transcript
but are omitted from the model history: they are not portable provider reasoning
items. Visible answers and tool exchanges retain their order, and reasoning-only
messages do not create empty model messages.
Pi-style `call_id|item_id` tool identities are split before replay: calls and
results share the sanitized, at-most-64-character call part. DSH keeps the full
original identity, including during compaction; ambiguous projected call IDs
are rejected instead of merging tool exchanges.

After each successful turn, the adapter replaces that session's checkpoint in
DSH's private `nanocodex_checkpoints` storage domain and awaits persistence.
The record includes the Nanocodex snapshot and an exact active
surface boundary (replacement generation, surface sequence list, message count,
and fingerprint). A new Host uses a checkpoint only when its route and boundary
match; otherwise it hydrates the current DSH surface and never lets stale engine
state override newer facts. Browser-visible `request/context` events contain
only route and context-window metadata; image-heavy engine snapshots never
travel in history pages. The private domain closes with the plugin and retains
one latest checkpoint per session across Host restarts.

## Compaction ownership

Nanocodex performs manual and automatic custom compaction on the retained live
runtime. Before each summary it sends a non-generating `purpose: "compaction"`
request through DSH's existing `llm/stream` waterfall, ending at an empty
stream. The original Companion middleware therefore selects its product-owned
continuity instruction for configured sessions; this package does not copy or
rewrite that prompt. Unconfigured sessions use the adapter's short generic
continuity instruction. Selection failure, cancellation, or an empty
instruction aborts the operation without a default prompt fallback.

The DSH policy keeps the newest suffix of at most five complete visible
user/assistant text rounds, subject to a 4,000-token soft budget at whole-round
boundaries. The newest complete round remains intact even when it is oversized.
The current unfinished input and progress—including pending attachments and
tool exchanges—remain outside that historical budget. Historical plugin
context, reasoning, completed attachments, and tool calls/results are removed;
selected mixed messages are replaced by text-only copies. The human-readable
DSH transcript remains available through ordinary replacement events, while
the private Nanocodex continuity summary is not rendered as assistant text.

The adapter consumes Nanocodex's `model.compaction.replaced` outcome exactly
once per live runtime/revision. The immutable callback decision and the public
`installed_history` provenance (`kind`, `id`, and `call_id`) are the authority;
the adapter does not infer a range from a history length or contiguous numeric
sequence tail. DSH surface segments are validated in current surface order,
including non-contiguous segments and nonmonotonic sequence numbers. Manual
compaction is exposed through the normal `/compact`/`compactNow` path; the
arbitrary `compactRegion` range entry point is rejected before model or
surface mutation because it cannot carry this complete immutable policy.

The successful replacement stays in the same Nanocodex runtime, preserving its
model/tool configuration and transport policy. If mapping or DSH persistence
fails after installation, the runtime is invalidated and the next request
rebuilds from the authoritative DSH surface. Failed or canceled generation
does not publish a successful checkpoint. The next ordinary request may miss
the provider cache after replacement; cache-hit evidence requires authorized
Owner acceptance and is not inferred from the local smoke.

## Context and usage accounting

The pinned Nanocodex engine has a 272,000-token context window. The adapter
publishes that same value in resolved model metadata and the `request/context`
facts written with private checkpoints. The value is deliberately fixed to the
pinned artifact; it is not discovered from a live provider or inferred from a
model name. At compaction outcome and snapshot boundaries, the adapter consumes
Nanocodex's public `context_window_tokens` and `active_context_tokens` values;
the DSH event contains only route and window metadata, not a large engine
snapshot or a fabricated context breakdown.

Compaction records `shadowedTokenCount` from the DSH token-meter estimator for
the exact messages removed or rewritten on the active surface. This includes
role and content framing as well as tool-call and tool-result structure. The
aggregate returned result is measured before any replacement mutates sequence
IDs, and each emitted prune/summary event records its own corresponding
surface estimate. The active surface order is authoritative even when
replacement sequence numbers are not numerically ordered.

Provider usage is normalized into disjoint DSH buckets in both ordinary model
events and ancillary one-shot calls: cache-read and cache-write tokens are
removed from `inputTokens`, while reasoning tokens remain a subset of
`outputTokens`. Warmup and compaction events do not establish the normal
current-request pressure anchor; a completed ordinary model call does.

This fix does not rewrite historical Host records or claim to repair the old
Host conversation-message breakdown, which can remain inflated until the
planned official Host upgrade. The separate companion-context-accounting work
and any future Nanocodex metrics API are outside this package change.

## Hosted transport fallback

The adapter passes the configured `baseURL` and `websocketURL` to Nanocodex's
public Node `Transport.openAi` route for ordinary Agent turns, manual
compaction, and ancillary LLM requests. Nanocodex initially prefers its
WebSocket transport. A failure during connection, before response output or
tool execution, falls back to POST HTTPS/SSE; caller cancellation,
authentication or validation failures, and failures after output begins are not
resubmitted. SSE remains sticky for the affected Node runtime, so the adapter
does not add a second loop, provider switch, or fallback settings surface.

Each eligible fallback is projected to the existing Host logger under
`dsh-nanocodex.transport` as a sanitized
`nanocodex.transport_fallback` record containing the DSH session, request
correlation, previous/next transport, error class, and reason. Credentials,
headers, request bodies, prompts, provider errors, and private compaction data
are not included, and the record is not published as Companion chat.

For an authorized live check, obtain the exact Host PID (for example, with
`systemctl --user show dsh-dev.service --property=MainPID --value`), attach a
loopback Node Inspector to that process (if it is not already listening, the
authorized operator can send `SIGUSR1`, then use the target from
`http://127.0.0.1:9229/json/list`), and pause in a Nanocodex engine or LLM
adapter method where the live `this.ctx` is in scope. Evaluate this scoped
query; do not import a new Cordis root or dump the full buffer:

```js
this.ctx.logger.buffer
  .filter((entry) => entry.name === "dsh-nanocodex.transport")
  .map((entry) => entry.args[0])
  .filter((record) => record?.kind === "nanocodex.transport_fallback");
```

Resume execution, disconnect the Inspector, and disable/close the loopback
Inspector when finished. The in-process logger retains the latest 1,000
messages across logger names; a Host restart discards them. The built-in buffer
is not exported to the systemd journal by default, so use an existing Host
logger exporter only when an external sink is already configured. The plugin
does not create a second telemetry store.

## Development

```sh
corepack pnpm --filter @lamplitisles/dsh-nanocodex run typecheck
corepack pnpm --filter @lamplitisles/dsh-nanocodex run test
corepack pnpm --filter @lamplitisles/dsh-nanocodex run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-nanocodex run pack-smoke
```

The plugin uses Nanocodex's public `createQuickJsEvaluator` binding. DSH tools
are exposed to Code Mode as guarded bridge functions; their calls retain the
real DSH agent, session identity, and cancellation signal.

The packed smoke uses a test-owned official DSH `0.1.2-rc.1` runtime and a
loopback scripted provider. It does not use live credentials or the persistent
development profile. Its Nanocodex provider rejects WebSocket upgrades and
serves the scripted responses through local HTTP/SSE, proving the actual packed
WASM/QuickJS fallback path and the queryable Host diagnostic.

## License

[Apache-2.0](LICENSE).
