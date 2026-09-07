# Hindsight 0.9.2 and the Codex bridge

## Planned architecture

Hindsight 0.9.2 includes an `openai-responses` LLM provider. Point that provider at
[`kepos-codex-bridge`](https://github.com/lamplitisles/kepos-codex-bridge).
This repository already depends on the 0.9.2 TypeScript client; the remaining
change described here is the Hindsight **server** runtime and its provider
configuration.

The important distinction is the authentication boundary:

```text
Hindsight 0.9.2
  -- OpenAI Responses request + non-empty API key --> kepos-codex-bridge
  -- bridge-managed ChatGPT OAuth ----------------> Codex upstream
```

Hindsight itself does **not** perform OAuth for this provider. It uses the
OpenAI client shape: base URL, model, and a non-empty API key. This is desirable
here because the bridge accepts that request, removes caller-supplied upstream
authorization, and injects the bridge-managed OAuth bearer/account identity.

## Intended server configuration

The Hindsight server—not Codex, DSH, or the calling agent—must own the provider
selection:

```text
HINDSIGHT_API_LLM_PROVIDER=openai-responses
HINDSIGHT_API_LLM_BASE_URL=http://codex-bridge.localhost:17480/codex/buffered
HINDSIGHT_API_LLM_API_KEY=<non-empty bridge capability or placeholder>
HINDSIGHT_API_LLM_MODEL=<model accepted by the managed Codex account>
```

The OpenAI SDK appends `/responses`, producing the buffered bridge endpoint
`/codex/buffered/responses`. The bridge forwards the request's model field, so the cold
seed/backfill target can be Luna when the managed account accepts its actual
model identifier.

Running a calling coding agent with Luna is not sufficient by itself. Retain,
observation consolidation, reprocessing, reflect, and knowledge-page work are
performed by the Hindsight server's configured providers.

## Security boundary

- The Hindsight-side API key satisfies the OpenAI-compatible client contract
  and may also be used as a local bridge capability.
- It is not the ChatGPT OAuth credential.
- Hindsight should never receive or persist the managed upstream bearer token.
- The bridge should continue stripping peer `Authorization`, API-key, and
  account-identity headers before injecting its own managed credentials.
- Model selection remains caller-owned; OAuth identity remains bridge-owned.

## Upgrade checklist

1. Upgrade Hindsight to 0.9.2 without changing the companion bank ID or prompt
   source of truth.
2. Confirm `/codex/buffered/responses` with one small non-retain request through the
   bridge.
3. Configure the Hindsight server provider/base URL/key/model.
4. Run one tiny test-bank retain and verify extraction, usage accounting, and
   absence of upstream credentials in Hindsight logs.
5. Verify observation consolidation separately; a successful fact extraction
   does not prove every background model call works.
6. Only then enable a coding-agent cold seed or historical backfill.

The bridge route must be deployed before switching Hindsight to this base URL.
