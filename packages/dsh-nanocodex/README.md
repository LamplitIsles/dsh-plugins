# DSH Nanocodex

This package replaces the selected DeepSeek Harness agent loop with the
Nanocodex Node/WASM engine. DSH remains the owner of session events, settings,
credentials, workspace policy, and tool execution; Nanocodex owns model
execution, Code Mode, QuickJS, and model-context compaction.

The package currently consumes the merged Nanocodex checkout through a local
`file:` dependency during development. The dependency must be prepared from
the sibling checkout before installing this workspace; no sibling checkout is
required by the packed artifact: `prepack` copies the Nanocodex and
`nanocodex-tools` tarballs into `vendor/`, rewrites their internal imports, and
removes the local dependency entries from the packed manifest. The exact source
revision is recorded in `docs/IMPORTS.md` and
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

Existing sessions are continued from DSH's active surface through typed
`historySeed` hydration. Text-only reasoning blocks remain in the DSH transcript
but are omitted from the model history: they are not portable provider reasoning
items. Visible answers and tool exchanges retain their order, and reasoning-only
messages do not create empty model messages.
Pi-style `call_id|item_id` tool identities are split before replay: calls and
results share the sanitized, at-most-64-character call part. DSH keeps the full
original identity, including during compaction; ambiguous projected call IDs
are rejected instead of merging tool exchanges.

After each successful turn, the adapter also appends a versioned
`nanocodexCheckpoint` to DSH's `request/context` event and awaits the
session flush. The record includes the Nanocodex snapshot and an exact active
surface boundary (replacement generation, surface sequence list, message count,
and fingerprint). A new Host uses a checkpoint only when its route and boundary
match; otherwise it hydrates the current DSH surface and never lets stale engine
state override newer facts. No private sidecar or separate transcript is used.

## Compaction ownership

Nanocodex performs manual and automatic custom compaction on the retained live
runtime. Before each summary it sends a non-generating `purpose: "compaction"`
request through DSH's existing `llm/stream` waterfall, ending at an empty
stream. The original Companion middleware therefore selects its product-owned
continuity instruction for configured sessions; this package does not copy
that prompt. Unconfigured sessions use the adapter's short generic continuity
instruction.

The adapter consumes Nanocodex's `model.compaction.replaced` outcome exactly
once per live runtime/revision. Its half-open model-history range and ordered
retained-tail identities are mapped to DSH messages by exact history-item
`kind`, `id`, and `call_id`, including complete retained tool exchanges. The
DSH surface then replaces the prefix before the latest real user-led tail with
the normal private compaction checkpoint. A public `compactRegion` request is
supported only for that current prefix; arbitrary middle ranges fail with a
`changed` error before any model or surface mutation.

The successful replacement stays in the same Nanocodex runtime, preserving its
model/tool configuration and transport policy. If mapping or DSH persistence
fails after installation, the runtime is invalidated and the next request
rebuilds from the authoritative DSH surface. Failed or canceled generation
does not publish a successful checkpoint. The next ordinary request may miss
the provider cache after replacement; cache-hit evidence requires authorized
Owner acceptance and is not inferred from the local smoke.

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
