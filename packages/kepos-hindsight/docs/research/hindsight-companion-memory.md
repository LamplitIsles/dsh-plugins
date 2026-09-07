# Hindsight companion-memory notes

Operating notes as of 2026-08-29. This is the entry point; detailed notes are
split by subject so provider, prompt, retrieval, and migration decisions can
evolve independently.

For the stable product comparison, runtime contract, and design philosophy, see
[Companion memory design](../companion-memory-design.md). The notes below retain
the deeper research and operational evidence behind that design.

## Topic index

- [Coding-agent memory versus companion memory](hindsight-coding-vs-companion.md)
- [Prompt, mission, strategy, and extraction modes](hindsight-prompt-and-extraction.md)
- [Session documents and historical backfill](hindsight-session-retain-and-backfill.md)
- [Cold-start token cost and billing](hindsight-cold-start-costs.md)
- [Reranking: local cross-encoder versus RRF](hindsight-reranking.md)
- [Hindsight 0.9.2 and the Codex bridge](hindsight-openai-responses-bridge.md)
- [Companion-agent ecosystem references](hindsight-companion-ecosystem.md)

## Current deployment decisions

1. Keep the official coding-agent integration for coding workspaces, but keep
   the DSH companion bank separate as `yuki-memory`.
2. Use raw recall before every direct companion turn. Reserve reflect for
   questions that require evidence-based synthesis across memories.
3. Retain asynchronously into one stable document per session, preserving raw
   transcript text as the reprocessing source of truth.
4. Keep companion prompts in workspace-owned configuration rather than plugin
   source. The DSH adapter should not select a named strategy or overwrite bank
   missions.
5. Use `custom` extraction for the companion bank and RRF for the current
   CPU-only, latency-sensitive recall path.
6. Treat the first coding-agent seed/deepen pass and historical backfills as
   explicit migrations with a model and cost plan.
7. After upgrading Hindsight from 0.8.6 to 0.9.2, use the
   `openai-responses` provider through `kepos-codex-bridge`; Hindsight speaks an
   API-key-shaped interface to the bridge, while the bridge owns upstream
   ChatGPT OAuth.

These are design and operating decisions, not evidence that the corresponding
live service upgrade has already been deployed.
