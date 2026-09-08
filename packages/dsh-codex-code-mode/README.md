# DSH Codex code mode

`@lamplitisles/dsh-codex-code-mode` adds an explicitly selected Codex
Responses provider route for DeepSeek Harness. It presents DSH's existing
PTC `run_code` tool as one raw TypeScript source string at the Codex custom
tool boundary, then restores DSH's canonical `{ code, description }` call for
the normal tool pipeline.

The package is Host-only. It does not replace another provider, enable PTC
globally, copy DSH's executor, or add a second sandbox.

## Install and compose

Requires Node.js 24+ and the DSH `0.1.2-rc.1` contract family. Install the
package into the profile that should own the route, then restart that profile:

```sh
dsh plugin --profile web add @lamplitisles/dsh-codex-code-mode
```

The package registers the `dsh-codex-code-mode` settings namespace and the
distinct `codex-code-mode` provider route. Enable PTC in the existing DSH
tools composition and load the published TypeScript worker-thread code
runtime, for example in the profile composition that already owns the other
DSH services:

```yaml
- id: tools-ptc
  name: "@deepseek-ai/dsh-tools"
  config:
    mode: ptc
- id: code-runtime
  name: "@deepseek-ai/dsh-code-runtime-worker-thread"
```

The exact profile rows and settings storage are deployment-owned. This
package's bundle patch injects `llm`, `credentials`, `settings`, and the
existing `sessions` service; it does not modify an existing live profile for
you.

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
```

`baseURL` must be an HTTP(S) gateway URL, `credentialRef` must name the DSH
credential to resolve for each request, and at least one model is required
when the route is enabled. The credential value is never copied into settings,
environment variables, logs, or the bundle patch. Store or rotate it through
the DSH credentials service; a subsequent request resolves the current value.

Select the route explicitly in the model configuration:

```yaml
provider: codex-code-mode
model: gpt-5-codex
```

Other provider routes remain unchanged. A disabled section removes this route
while leaving the settings registration available for a later opt-in.

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

The wire custom tool has one required string field, `input`, constrained by a
small Lark grammar to non-empty source. The plugin adds the fixed canonical
execution label `Run code` only when converting the accepted call back to DSH.
The grammar does not prove JavaScript validity or make source execution safe.
Requests are admitted only when the existing DSH PTC `run_code` entry is
present; this route does not silently fall back to native ordinary tools.

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
activates it through Cordis Loader, sends two requests through a local fake
Codex WebSocket, runs two test tools through the real DSH PTC runtime, checks
cached continuation history, and unloads the plugin. It uses no live
credentials, provider, profile, paid service, or user workspace.

## License

[Apache-2.0](LICENSE).
