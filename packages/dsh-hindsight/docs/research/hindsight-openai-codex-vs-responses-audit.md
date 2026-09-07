# Hindsight 0.9.2 `openai-codex` versus `openai-responses`

Source-level audit for the companion-memory deployment, 2026-08-29.

> Route update (2026-09-03): the deployed `/hindsight/responses` evidence below
> records the adapter tested during this audit. Its replacement is
> `/codex/buffered/responses`, reached by configuring Hindsight's OpenAI SDK
> base URL as `/codex/buffered`.

## Verdict

The deployed `openai-responses` → `/hindsight/responses` path has **no hard
blocker for the currently exercised companion-memory calls**. The live matrix
covered ordinary text, the default soft structured-output path, a forced
function call, and a follow-up containing `function_call` plus
`function_call_output`; all completed through `gpt-5.6-luna`, and usage survived
the SSE-to-JSON reduction.

The most important requested fact is unambiguous: **Hindsight 0.9.2 emits
`store: false` on both `OpenAIResponsesLLM.call()` and
`OpenAIResponsesLLM.call_with_tools()`**. It is a real JSON boolean sent by the
pinned OpenAI Python SDK, not merely a client-side default. [ordinary
request](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L427-L465)
· [tool
request](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L523-L583)
· [SDK body
serialization](https://github.com/openai/openai-python/blob/v2.24.0/src/openai/resources/responses/responses.py#L859-L942)

There are nevertheless four material residual gaps:

1. **Output limits are not enforced.** Hindsight sends `max_output_tokens`, but
   the adapter removes it because the ChatGPT Codex backend rejects it. The
   response header reporting the removal is not inspected by Hindsight. This
   disables Hindsight's truncation signal and leaves the bridge's 4 MiB buffer
   as the only hard response-size bound. It matches the effective behavior of
   Hindsight's `openai-codex` provider, which also ignores
   `max_completion_tokens`, but it is not public Responses equivalence.
2. **`store: false` is a hard upstream precondition, not an adapter invariant.**
   The adapter preserves the field rather than setting it. Current Hindsight is
   safe; a future regression or `EXTRA_BODY={"store":true}` would produce an
   upstream 400. A probe omitting `store` did exactly that.
3. **The bridge refreshes and replays on upstream 401 only.** Hindsight's native
   provider does the same for 401 or 403. Proactive bridge-owned refresh covers
   normal expiry, but a backend 403 that needs credential rotation is not
   recovered on the deployed path.
4. **The request is accepted empirically, not through a stable public ChatGPT
   backend contract.** The bridge does not synthesize Codex's `originator`,
   Codex `User-Agent`, stable `prompt_cache_key`, or
   `include: ["reasoning.encrypted_content"]`. Luna accepts the present request,
   but future model gating or backend validation could make those omissions
   breaking.

The cutover should therefore stay in place, with these limitations treated as
known operational debt rather than evidence of full OpenAI Responses
compatibility.

## Source pin and evidence boundary

All Hindsight implementation claims below are pinned to annotated tag
`v0.9.2`, tag object `52dcd3f80e1e1999685c7f083e013b47ee8bc8a5`, peeled commit
[`ebad478240d3171bb88201ececda5e8d9883d22d`](https://github.com/vectorize-io/hindsight/commit/ebad478240d3171bb88201ececda5e8d9883d22d).
The root lock selects OpenAI Python `2.24.0`; its generated Responses client is
therefore part of the effective 0.9.2 wire implementation. [Hindsight
dependency](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/pyproject.toml#L12-L20)
· [lock entry](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/uv.lock#L3308-L3325)

The bridge claims are pinned to deployed source commit
[`255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b`](https://github.com/lamplitisles/kepos-codex-bridge/commit/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b).
Its managed-auth implementation is pinned by `Cargo.lock` to Nanocodex commit
[`7068272602508100b166715b4dfa68c3c36cdf22`](https://github.com/gakonst/nanocodex/commit/7068272602508100b166715b4dfa68c3c36cdf22).

For the canonical Codex request shape, this audit also checked OpenAI's own
Codex source at commit
[`6478a751fde8884b2fdc76486fe23175a8e795d4`](https://github.com/openai/codex/commit/6478a751fde8884b2fdc76486fe23175a8e795d4).
That source is evidence of the first-party client's behavior, not a promise that
the private ChatGPT backend is a supported third-party API.

The official Responses documentation says responses are stored by default and
that `store: false` disables that behavior. It also describes `instructions`,
`include`, streaming, token limits, tools, service tier, and prompt-cache fields.
[create reference](https://developers.openai.com/api/reference/resources/responses/methods/create/)
· [state guide](https://developers.openai.com/api/docs/guides/conversation-state)

## Current deployment snapshot

The deployed Kosmos configuration selects:

- Hindsight image
  `ghcr.io/vectorize-io/hindsight:0.9.2@sha256:84ab276b8f501546deb6ea9c64a57291718b4e16a59dd9e02a02fdd5adfe9028`;
- provider `openai-responses`;
- base URL `http://codex-bridge.localhost:17480/hindsight`;
- model `gpt-5.6-luna` and reasoning effort `high`;
- a 300-second global per-attempt LLM timeout, inherited by retain, reflect,
  and consolidation;
- a non-secret API-key initializer `bridge-managed-oauth`; and
- bridge image
  `ghcr.io/lamplitisles/kepos-codex-bridge:sha-255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b@sha256:ab8c98c458155a0d5e08d9a611c2291b2f30eca5f0d24b27f3a58fcd8a860ba6`.

The current local Hindsight and bridge manifests live in the separately
managed Kosmos deployment repository and are outside this source-only import.
The owning Kosmos runbook and manifests both name `/hindsight`; the earlier
`/codex` documentation drift was corrected before deployment.

## Request payload, field by field

The table describes Hindsight 0.9.2 before bridge rewriting, followed by the
effective Codex-upstream request where that differs.

| Concern | `openai-codex` | `openai-responses` through the adapter | Consequence |
| --- | --- | --- | --- |
| Endpoint | Defaults to `https://chatgpt.com/backend-api/codex/responses`; a non-`/v1` custom base is used literally and gets `/codex/responses` appended. | OpenAI SDK appends `/responses` to its base. Current `/hindsight` therefore selects `/hindsight/responses`; the bridge forwards to its configured ChatGPT Codex base plus `/responses`. | Current route is correct. `/codex` would select the transparent relay and return SSE to a JSON client. |
| System/developer input | Removes every `role=system` message from `input`, joins their contents with blank lines, and sends the result as `instructions`. | Keeps system messages in the `input` array and omits `instructions`. | Different token layout and cache prefix. The live backend accepts the latter today. |
| Non-system input | Sends typed message objects in `input`. | Sends role/content message objects. On tool-loop continuation, converts assistant `tool_calls` to `function_call` items and `role=tool` messages to `function_call_output` keyed by `call_id`. | `openai-responses` preserves the public Responses tool protocol more faithfully. Native Codex instead turns a tool result into a user message prefixed `Tool result:` and drops assistant `tool_calls` from history. |
| `store` | Always `false`. | Always `false` in ordinary and tool calls; bridge preserves it. | Required by the ChatGPT backend. This answers the deployment's main uncertainty. |
| `stream` | Always `true`. | Omitted by Hindsight, so SDK requests a single JSON Response. The adapter overwrites any incoming value with `true` upstream and buffers back to JSON downstream. | Necessary transport adaptation; downstream latency remains non-streaming. |
| `include` | Always `['reasoning.encrypted_content']`. | Omitted. | No encrypted reasoning is requested or replayed. Both Hindsight providers are stateless and their parsers discard reasoning items, so this is mainly a quality/forward-compatibility difference today. |
| `reasoning` | Always sends a `summary` (`auto`, `concise`, or `detailed`); sends configured `effort` unchanged. `gpt-5.2-*` forces `summary=detailed`. | Sends only `{'effort': configured}` and only when the model name contains `gpt-5`, `o1`, or `o3`. Current Luna matches. | Current `high` reaches upstream; presentation/summary policy differs. |
| Maximum tokens | Accepts `max_completion_tokens` but never serializes it on either path. | Ordinary reasoning calls raise any configured value below 16,000 to 16,000; tool calls send the value unchanged as `max_output_tokens`. The adapter removes the field in both cases. | Effective upstream behavior is uncapped for both providers. `openai-responses` can no longer receive `status=incomplete/reason=max_output_tokens`, so its `OutputTooLongError` branch cannot fire because of the requested limit. |
| Temperature | Accepted but never sent. | Sent only for non-reasoning models; omitted for current Luna. | No current difference. |
| Ordinary tools | Sends `tools=[]`, `tool_choice='auto'`, and `parallel_tool_calls=true`, except the strict-schema forced-tool case. | Omits all three when making an ordinary text/structured call. | Backend defaults apply to the new path. |
| Tool definitions | Assumes Chat-shaped nested functions and flattens them. | Flattens nested functions but preserves already-flat or built-in tool definitions. | `openai-responses` is more general. |
| Tool choice | Always sends the selected mode. A named choice is the flat Responses shape. | Omits auto; sends `required`/`none`; for a named choice, validates that exactly one declaration matches, filters the tool list to that declaration, then sends the flat named choice. | Better validation and smaller named-tool request on the new path. |
| Parallel tool calls | Always `true` on normal tool calls. | Omitted. | Backend default; the live forced-call path worked, but parallel multi-call parity was not live-tested. |
| Strict structured output | Creates one function tool named `structured_response`, uses the Pydantic schema as its parameters, forces that tool, and sets parallel calls false. | Uses public `text.format={type:'json_schema', name:'response', strict:true, schema:...}`. | Different constrained-decoding mechanism. Bridge preserves either field shape, but current deployment defaults strict mode off. |
| Soft structured output | Appends the schema to `instructions` and parses free-form text. | Appends/prepends the schema to the first string-content input message and sets `text.format.type='json_object'`. | The deployed default path uses a stronger JSON mode and passed the live probe. |
| Service tier | No first-class support; can be injected through `EXTRA_BODY`. | Sends configured `openai_service_tier` on both paths. Current value is unset. | Not a current compatibility requirement. The canonical Codex client may send a tier. |
| Extra body | `payload.update(extra_body)`, so extra keys can add or overwrite any core field. | Passes `extra_body` to the SDK; OpenAI Python merges it after the generated body, so duplicate keys also win. | Either provider can be misconfigured to override `store`. The adapter subsequently forces only `stream=true` and removes only `max_output_tokens`. |
| Bank attribution | Not applied. | Optionally adds `user=<bank_id>` when `LLM_SEND_BANK_AS_USER` is enabled. Current default is off. | Untested against the ChatGPT backend and absent today. |
| Cache key | Generates a random UUID per Hindsight call. Retries of that call reuse it, but later calls do not. | Sends no `prompt_cache_key`; its `cached_prefix` arguments and the server's cache-affinity setting are unused by this provider. | Neither Hindsight path has first-party Codex's stable per-session cache affinity. The adapter does not invent one. |

The native payload construction is in [ordinary
`call`](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L384-L505)
and [tool
`call`](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L763-L883).
The Responses conversions and payloads are in [message/tool
conversion](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L73-L163),
[ordinary
`call`](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L427-L521),
and [tool
`call`](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L523-L640).
OpenAI Python explicitly gives `extra_body` precedence on duplicate keys.
[merge](https://github.com/openai/openai-python/blob/v2.24.0/src/openai/_base_client.py#L479-L508)
· [precedence](https://github.com/openai/openai-python/blob/v2.24.0/src/openai/_base_client.py#L2154-L2163)

For comparison, OpenAI's current first-party Codex client sends `instructions`,
`input`, tools, `tool_choice`, parallel policy, reasoning, `store:false`,
`stream:true`, encrypted-reasoning inclusion, service tier, a stable
`prompt_cache_key`, text controls, and client metadata. [request
type](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/codex-api/src/common.rs#L274-L300)
· [construction](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/client.rs#L970-L1032)

## Headers and authentication

### Native `openai-codex`

Hindsight loads `$CODEX_HOME/auth.json` (falling back to `~/.codex/auth.json`),
requires `auth_mode='chatgpt'`, ignores the configured API key, and owns the
access/refresh token lifecycle. Its request headers are:

- `Authorization: Bearer <access token>`;
- `Content-Type: application/json`;
- `OpenAI-Account-ID: <account>`;
- `User-Agent: codex_cli_rs/0.0.0 (Hindsight)`;
- `Origin: https://chatgpt.com`; and
- `originator: codex_cli_rs`.

It proactively refreshes 60 seconds before JWT expiry, uses async and
cross-process single-flight locking, adopts a same-account rotation from disk,
persists rotated tokens atomically, and performs one forced refresh/retry on
either 401 or 403. [initialization and
headers](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L114-L212)
· [refresh
policy](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L42-L123)
· [reactive ordinary
path](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L634-L704)

`OpenAI-Account-ID` differs from the current first-party Codex source, which
uses `ChatGPT-Account-ID`. [OpenAI Codex auth
headers](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L46)

### `openai-responses` through the bridge

Hindsight explicitly requires a non-empty API key and passes it to
`AsyncOpenAI`.
The SDK emits that placeholder as bearer authorization and may add configured
default headers. The bridge removes peer `Authorization`,
`Proxy-Authorization`, `x-api-key`, `Cookie`, `ChatGPT-Account-ID`, and
`X-OpenAI-Fedramp`, plus hop-by-hop framing, then injects its managed bearer,
`ChatGPT-Account-ID`, and optional FedRAMP header. Other caller headers are
forwarded. Response `Set-Cookie` is never forwarded. [Hindsight client
setup](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L173-L234)
· [bridge request
send](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L110-L156)
· [header
filter](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L562-L655)

The pinned managed-auth source proactively refreshes expiring tokens during
`snapshot()`, adopts a same-account on-disk rotation, persists refreshed
credentials, and offers reactive unauthorized recovery. The bridge invokes
that recovery exactly once only when the upstream HTTP status is 401.
[managed
snapshot/recovery](https://github.com/gakonst/nanocodex/blob/7068272602508100b166715b4dfa68c3c36cdf22/crates/nanocodex-oai-api/src/auth/chatgpt.rs#L452-L675)
· [bridge 401
branch](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L110-L133)

The bridge does **not** replace the caller's user agent or add `originator` or
`Origin`. The first-party Codex client supplies default `originator` and
Codex-specific `User-Agent` headers, while its bearer provider supplies
`ChatGPT-Account-ID`. [default
headers](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/login/src/auth/default_client.rs#L164-L227)
· [header
installation](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/login/src/auth/default_client.rs#L335-L349)

## Transport, timeout, and retry behavior

| Concern | `openai-codex` | `openai-responses` + bridge |
| --- | --- | --- |
| Client transport | `httpx.AsyncClient.post()` to an SSE endpoint with `stream:true`, then line iteration. Because `post()` is not entered with HTTPX streaming mode, the response is normally buffered before parsing. | OpenAI SDK expects one JSON body. Bridge forces an SSE upstream request, buffers it fully, and returns one JSON body. |
| Timeouts | Hard-coded 120-second HTTPX client and per-request timeout; OAuth refresh is 30 seconds. | Hindsight's SDK timeout is configurable globally and per operation, defaulting to 120 seconds. The deployment gives retain and consolidation 300 seconds per attempt. SDK retries are disabled. Bridge's Reqwest client has redirects disabled but no explicit request timeout, so Hindsight's selected per-operation deadline is the practical bound. |
| Ordinary retries | Configured retry budget (current default 3 retries after the first attempt) for every non-auth HTTP status and connection error, exponential backoff without jitter. One additional auth-recovery attempt for 401/403. | Same Hindsight retry budget for connection errors, malformed structured JSON, and non-auth API status errors. Backoff is exponential; status errors add ±20% jitter. 401/403 fail fast at Hindsight, but the bridge has already made one extra attempt for a 401. |
| Tool retries | Despite accepting a retry budget, the native implementation performs no ordinary retry. It only retries once after 401/403 refresh. | Uses the configured retry loop just like ordinary calls. |
| Request/response bounds | No provider-local body bound. | Bridge enforces 4 MiB request and successful adapted-response limits. |
| Redirects | HTTPX defaults apply. | Bridge does not follow upstream redirects; it relays their status, safe headers, and body. |

The Responses retry loop disables SDK retries with `max_retries=0` and handles
errors itself. It fails fast on 401/403 and retries other statuses, connection
errors, and JSON decoding failures. [client
policy](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L203-L230)
· [retry
loop](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L336-L425)
The global default is three retries and 120 seconds. [defaults](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/config.py#L958-L963)
Hindsight 0.9.2 exposes retain, reflect, and consolidation timeout overrides and
threads their resolved values into the corresponding provider instances.
[environment names](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/config.py#L328-L375)
· [per-operation resolution](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L1964-L1994)

The bridge transport and size limits are implemented in its [client and
routes](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L31-L100)
and [bounded response
reader](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L402-L414).

## SSE/JSON reduction, tools, usage, and errors

### Native reduction

For ordinary calls, `openai-codex` concatenates recognized text delta events
and text found in completed item content; malformed event JSON is silently
skipped. For tool calls, it recognizes only `response.text.delta` for text and
completed `function_call` items from `response.output_item.done`. It repairs
some invalid JSON escapes, otherwise replaces invalid arguments with `{}`.
It does not validate or surface a terminal `response.failed` or
`response.incomplete` event. [text
parser](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L710-L761)
· [tool
parser](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L978-L1038)

The provider ignores real terminal usage even when present. Ordinary metrics
record zero; optional returned usage is a `len(text)//4` estimate. Tool usage is
always zero. [ordinary
usage](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L518-L630)
· [tool
usage](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L925-L970)

### Adapter plus SDK reduction

The adapter buffers successful SSE, accepts arbitrary chunk boundaries and
CRLF, and collects every object-valued `response.output_item.done` by numeric
`output_index`. It takes the first valid `response.completed`,
`response.incomplete`, or `response.failed` object's `response`, replaces its
`output` with the sorted completed items when any were seen, and returns it as
`application/json`. Unknown well-formed events are ignored. Malformed
recognized events, an oversized stream, or a stream without a terminal response
become a generic 502 without partial data. [request
rewrite](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L317-L356)
· [response
rewrite](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L358-L400)
· [SSE
aggregation](https://github.com/lamplitisles/kepos-codex-bridge/blob/255a4638ca6476a0f4fe5b79eeb54ebe0ae7280b/src/lib.rs#L416-L521)

OpenAI Python then produces `response.output_text` and typed output items.
Hindsight parses each `function_call`; valid argument JSON becomes a dict and
invalid JSON becomes `{'_raw': original}`. It uses real response usage,
including cached input and reasoning tokens, and subtracts reasoning tokens
from visible output. [usage
extraction](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L262-L293)
· [ordinary
parse](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L486-L521)
· [tool
parse](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L587-L640)

This path has one inherited error-semantic hole: Hindsight raises
`OutputTooLongError` only for `status=incomplete` with reason
`max_output_tokens`. A JSON `status=failed`, or another incomplete reason, is
not turned into an exception; it can be recorded as a successful empty result.
The bridge correctly preserves that terminal status, so the missing mapping is
in Hindsight 0.9.2 rather than the bridge. Native `openai-codex` is no better:
it ignores terminal events entirely.

For non-successful upstream HTTP responses, the bridge skips SSE adaptation
and relays status, safe headers, and body. Transport/auth/adaptation failures
generated by the bridge are plain generic 502 responses. The OpenAI SDK turns
those HTTP failures into `APIStatusError`, after which Hindsight's retry policy
applies.

## Connection verification

Both providers verify by asking `Say 'ok'` with two retries and short backoff.

- `openai-codex` requests `max_completion_tokens=10`, but never serializes the
  limit. A 429 or `usage_limit_reached` is treated as a warning and successful
  startup; other errors become `RuntimeError`.
- `openai-responses` requests 512 tokens. On a reasoning model it promotes the
  value to `max_output_tokens=16000`; the adapter removes the field. Any final
  failure, including quota exhaustion, becomes `RuntimeError`.

[Codex verification](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/codex_llm.py#L364-L382)
· [Responses verification](https://github.com/vectorize-io/hindsight/blob/ebad478240d3171bb88201ececda5e8d9883d22d/hindsight-api-slim/hindsight_api/engine/providers/openai_responses_llm.py#L241-L255)

The difference matters operationally: the new provider is stricter during a
subscription quota event. It also means its nominal 512-token verification cap
is not enforced through this backend.

## Supplied live-deployment observations

These are local probes against the deployed bridge image, kept separate from
the source claims above. They were supplied to this audit; this audit did not
start, stop, or deploy either service.

1. Omitting `store` at `/hindsight/responses` produced upstream HTTP 400:
   `Store must be set to false`.
2. With `store=false`, `model=gpt-5.6-luna`, reasoning effort `xhigh`, and
   `max_output_tokens=16000`, the route returned HTTP 200 JSON, the
   `x-kepos-ignored-parameters: max_output_tokens` header, real usage, and text
   `ok`.
3. The default soft structured path, `text.format.type=json_object`, returned
   valid JSON.
4. A flattened function tool with `tool_choice=required` returned a
   reconstructed `function_call`.
5. A follow-up input containing the prior `function_call` plus matching
   `function_call_output` returned a final assistant message.

These results prove the present companion path, the mandatory store field,
basic structured output, one tool round trip, and terminal usage reconstruction.
They do not prove strict JSON Schema mode, multiple parallel tool calls,
service tiers, bank attribution, configured extra-body fields, custom headers,
all terminal failure forms, or cache behavior.

### Post-cutover timeout observation

After the cutover, three already-queued `coding-agent::*` retain/consolidation
tasks made the default timeout visible in production. Smaller consolidation
calls completed in 9–54 seconds, while larger calls reached exactly 120 seconds,
raised `APIConnectionError: Request timed out`, and began another Hindsight
attempt. Both Pods remained healthy with zero restarts; observed CPU was 17m for
Hindsight and 6m for the bridge. This isolates the failure to Hindsight's client
deadline rather than CPU pressure, bridge transport, authentication, RRF, or a
Rust/Python performance difference.

Those obsolete Codex operations were cancelled after the coding-agent
integration was removed. The deployment first used the official retain and
consolidation timeout overrides, then standardized on
`HINDSIGHT_API_LLM_TIMEOUT=300` so every LLM operation inherits the same
deadline. It also reduced Luna reasoning effort from `xhigh` to `high`; the
earlier live probes above remain an exact record of the pre-tuning
configuration. The configurable deadline is a meaningful advantage over the
native `openai-codex` provider's hard-coded 120-second deadline: slow
companion-memory work can finish without paying for repeated attempts.

## Exact blocker and gap register

| Severity | Item | Current status | Required action |
| --- | --- | --- | --- |
| Hard precondition | ChatGPT Codex requires explicit `store:false`. | Satisfied by both Hindsight 0.9.2 request paths and confirmed live. Adapter does not enforce it. | Keep `EXTRA_BODY` unset or ensure it cannot override `store`; retain a request-shape regression test on Hindsight upgrades. |
| Material semantic gap | `max_output_tokens` is removed. | Every current limited request loses its cap and cannot trigger Hindsight's truncation handler. Native `openai-codex` was also uncapped. | Accept explicitly for now; do not describe the route as full Responses compatibility. Monitor the ignored-parameter warning and 4 MiB 502s. |
| Auth recovery gap | Bridge retries 401, not 403. | Normal expiry is proactively refreshed; a recoverable 403 remains a possible outage. | Extend only if a real 403 refresh failure is observed or a future bridge change is approved. |
| Protocol correctness gap | Hindsight treats most terminal failed/incomplete JSON responses as ordinary results. | Present in `openai-responses`; native Codex ignores terminal state too. | Upstream Hindsight fix is preferable; not a bridge-specific blocker. |
| Compatibility risk | No synthesized Codex `originator`, Codex UA/Origin, encrypted-reasoning include, client metadata, or stable cache key. | Luna accepts current traffic live. | Pin bridge/Hindsight images and rerun the small live acceptance matrix on upgrades or model changes. |
| Response bound | Successful SSE aggregation is capped at 4 MiB. | Deliberate; larger successful responses become generic 502. | Accept for companion workloads; revisit only with evidence of legitimate larger outputs. |
| Operational timeout | Large memory calls can exceed the 120-second default and trigger expensive retries. | Resolved with a 300-second global LLM timeout and by reducing Luna effort from `xhigh` to `high`. | Inspect timeout/retry logs before increasing retry budgets or reasoning effort. |
| Untested optional surface | Strict JSON Schema, parallel multi-tool calls, service tier, `user`, extra body, custom headers. | Not enabled in current Kosmos config. | Test before enabling; do not add speculative compatibility code. |

## Recommendation

Keep `openai-responses` with the buffered `/codex/buffered/responses` adapter. It is
the better Hindsight-side provider for companion memory because it preserves
tool-call history correctly, uses the SDK's typed JSON response, reports real
usage, retries tool calls, and supports the default JSON mode. Do not switch
back to native `openai-codex` merely for payload resemblance: that provider has
weaker tool-history representation, zero/estimated usage, no ordinary tool
retry, and its own drift from the current first-party Codex request.

Treat the route as a narrow, pinned compatibility adapter. The operational
acceptance condition is: Hindsight 0.9.2 continues to send `store:false`, the
bridge continues to force SSE and reconstruct terminal output, and the small
text/structured/tool/follow-up probe remains green after either image or model
changes.

Keep the explicit 300-second global timeout selected for this deployment.
Recall remains pure retrieval and is unaffected; LLM-backed reflect can now
wait longer before failing. Keep Luna at `high` unless representative memory
quality evaluations demonstrate that `xhigh` justifies its additional latency
and token cost.
