# DSH Codex code mode

`@lamplitisles/dsh-codex-code-mode` adds an explicitly selected Codex
Responses provider route for DeepSeek Harness. On that route the model gets
two direct custom tools: DSH's existing PTC `run_code` entry as one raw
TypeScript source string, and a raw `apply_patch` editor for Codex Add File and
Update File patches. Both calls are converted back to DSH's canonical tool
arguments before normal execution and history handling.

The package is Host-only. It does not replace another provider, enable PTC
globally, copy DSH's executor or filesystem backend, or add a second sandbox.

## Install and compose

Requires Node.js 24+ and the DSH `0.1.2-rc.1` contract family. Install the
package into the profile that should own the route, then restart that profile:

```sh
dsh plugin --profile web add @lamplitisles/dsh-codex-code-mode
```

The package registers the `dsh-codex-code-mode` settings namespace and the
distinct `codex-code-mode` provider route. Compose the existing DSH filesystem
backend and read-before-edit observation policy, enable the `both` tools
presentation, and load the published TypeScript worker-thread code runtime.
For example, add the following rows to the profile composition that already
owns the other DSH services:

```yaml
- id: tools-ptc
  name: "@deepseek-ai/dsh-tools"
  config:
    mode: both
- id: fs-local
  name: "@deepseek-ai/dsh-fs-local"
  config:
    cwd: /absolute/path/to/workspace
- id: fs-observation-policy
  name: "@deepseek-ai/dsh-fs-observation-policy"
- id: code-runtime
  name: "@deepseek-ai/dsh-code-runtime-worker-thread"
```

Use the sandbox filesystem backend instead of `fs-local` when the deployment
requires workspace confinement. The exact profile rows, ordering, filesystem
backend, and settings storage are deployment-owned. This package's bundle
patch injects `llm`, `credentials`, `fs`, `settings`, `systemPrompt`, `tools`,
and `sessions`; it does not add or modify those supporting services for you.
The `both` presentation is required because `ptc` alone cannot expose the
second direct patch tool.

## Settings and route selection

The namespace is dormant by default. Add a valid enabled section through the
DSH settings surface or the profile's settings document:

```yaml
dsh-codex-code-mode:
  enabled: true
  baseURL: https://codex-gateway.example
  credentialRef: CODEX_API_KEY
  transport: websocket-cached
  models:
    - id: gpt-5-codex
      name: GPT-5 Codex
      contextWindow: 262144
      maxTokens: 32768
  maxPatchChars: 4000000
  maxPatchFiles: 64
  maxPatchFileBytes: 4000000
```

`baseURL` must be an HTTP(S) gateway URL, `credentialRef` must name the DSH
credential to resolve for each request, and at least one model is required
when the route is enabled. The credential value is never copied into settings,
environment variables, logs, or the bundle patch. Store or rotate it through
the DSH credentials service; a subsequent request resolves the current value.
`maxPatchChars`, `maxPatchFiles`, and `maxPatchFileBytes` are positive safe
integers that bound the raw patch, operation count, and individual file sizes.
They default to 4,000,000 characters, 64 operations, and 4,000,000 bytes and
apply to live changes without restarting the Host.

Select the route explicitly in the model configuration:

```yaml
provider: codex-code-mode
model: gpt-5-codex
```

Other provider routes remain unchanged. A disabled section removes this route
while leaving the settings registration available for a later opt-in.

## Direct tools and SDK

The selected route advertises exactly these two direct tools, in this order:

| Tool          | Direct input                        | Purpose                                                |
| ------------- | ----------------------------------- | ------------------------------------------------------ |
| `run_code`    | one non-empty raw TypeScript string | Runs a fresh DSH PTC program.                          |
| `apply_patch` | one complete raw Codex patch string | Applies supported Add File and Update File operations. |

Other DSH tools remain available through the generated SDK inside `run_code`.
The route removes the ordinary SDK `edit` and `write` declarations and denies
those calls if a program tries to invoke them. Reads, shell commands, and
other permitted tools keep their normal DSH execution and permission paths.

## What the model can run

The existing DSH PTC runtime remains authoritative. A code-mode program is the
body of an async TypeScript function and calls the generated DSH SDK:

```ts
const [first, second] = await Promise.all([
  tools.some_tool({ value: 1 }),
  tools.other_tool({ value: 2 }),
]);
return { first, second };
```

Use the APIs and argument shapes described by DSH's generated `tools` SDK.
The released TypeScript runtime accepts erasable TypeScript syntax, top-level
`await`/`return`, `console` output, and JSON-compatible tool arguments/results.
Each `run_code` call starts a fresh runtime; there is no persistent cell,
Codex pragma, `yield`/`wait` protocol, or extra `text()`/`image()` API supplied
by this package. DSH's ordinary tool permissions, scheduling, cancellation,
result rendering, and durable history still apply to nested tool calls.

The wire `run_code` custom tool has one required string field, `input`,
constrained by a small Lark grammar to non-empty source. The plugin adds the
fixed canonical execution label `Run code` only when converting the accepted
call back to DSH. The grammar does not prove JavaScript validity or make
source execution safe. Requests are admitted only when the existing DSH PTC
`run_code` entry is present; this route does not silently fall back to native
ordinary tools.

### `apply_patch` syntax

The patch input follows the Codex envelope and supports only `Add File` and
`Update File` operations:

```text
*** Begin Patch
*** Add File: src/new-file.ts
+export const value = 1;
*** Update File: src/existing-file.ts
@@ function main
-  return oldValue;
+  return newValue;
*** End Patch
```

Updates use `@@` or `@@ <context>` markers, context lines beginning with a
space, additions beginning with `+`, removals beginning with `-`, and optional
`*** End of File` anchoring. Delete and Move operations, binary files, and
ambiguous or unmatched hunks are rejected before any file is published.
Paths resolve from the active Agent workspace; an Add must target an absent
file and an Update must target an existing regular text file.

The filesystem backend and observation policy remain authoritative. A patch
checks each existing target against the observation policy during preflight,
uses DSH's write-intent hook and version-guarded atomic writes, and records the
committed version only after each successful write. It never bypasses sandbox
or read-before-edit rules. The complete patch is parsed, resolved, checked for
duplicate targets, read, matched, and calculated before the first write. A
preflight failure therefore leaves every file unchanged.

Files publish in patch order. If a later guarded write fails or cancellation
arrives, earlier files stay committed: the result is `partial` or `cancelled`
with per-operation `committed`, `failed`, and `unattempted` statuses. There is
no cross-file rollback or automatic retry. Successful committed files retain
native diff metadata for the Host presentation, while the final content hook
also reports committed progress if the registry itself replaces a handled
failure with a generic error.

## Transport and inherited behavior

`transport` accepts `auto`, `sse`, `websocket`, and `websocket-cached`. The
Codex Responses implementation is the public pi-ai `0.84.4` implementation;
it owns WebSocket connection reuse, continuation state, transport fallback,
and protocol errors. A gateway must support the corresponding Codex Responses
endpoint and authentication format. The provider route does not implement a
new OAuth/account-login flow.

DSH and pi-ai retain their normal request cancellation, stream-idle timeout,
retry, and error handling. This release deliberately adds no generation
deadline, whitespace detector, code-size policy, automatic regeneration,
attempt buffering, or commit state machine. Invalid or failed programs follow
the ordinary DSH tool-result path and are not silently repaired.

The route owns its active streams and Codex cache entries for the lifetime of
the Host plugin. Disposing a DSH session aborts that session's in-flight
requests and releases its Codex transport resources; unloading the plugin
does the same for all of its remaining requests. Cache keys are scoped to this
plugin instance, the original DSH session, and the gateway endpoint, so
cleanup cannot close another provider route's connection. Successive requests
in one enabled route still reuse the same Codex session transport.

## Verification

From the workspace root:

```sh
corepack pnpm --filter @lamplitisles/dsh-codex-code-mode run typecheck
corepack pnpm --filter @lamplitisles/dsh-codex-code-mode run test
corepack pnpm --filter @lamplitisles/dsh-codex-code-mode run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-codex-code-mode run pack-smoke
```

The packed smoke installs the real package into a test-owned DSH profile,
activates it through Cordis Loader, sends patch, code, and continuation
requests through a local fake Codex WebSocket, applies an Add and Update via
the real DSH filesystem service, runs two test tools through the real DSH PTC
runtime, checks cached continuation history and an unrelated provider stream,
and unloads the plugin. It uses no live credentials, provider, profile, paid
service, or user workspace.

## License

[Apache-2.0](LICENSE).
