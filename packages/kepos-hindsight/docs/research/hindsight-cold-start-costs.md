# Cold-start token cost and billing

## Operational conclusion

Treat the official coding-agent integration's first seed/deepen run as a data
migration. It can ingest git history, codebase survey material, and historical
sessions, then trigger fact extraction and observation consolidation. Opening
many repositories before choosing the Hindsight server's model provider can
therefore produce a large one-time bill.

The same warning applies to OpenClaw historical backfill. A curated backfill is
smaller and more valuable than indiscriminate ingestion, but every retained
document can still cause extraction and downstream consolidation calls.

The official coding-agent defaults make the first-run boundary easy to miss:
`autoSeed` and codebase survey are enabled, and `seedLimit` defaults to 300
documents per bank. That cap prevents an unbounded import; it does not make the
first import cheap.

## 2026-08-29 deployment snapshot

Hindsight 0.8.6's successful trace records showed:

| Metric | Tokens / calls |
| --- | ---: |
| Successful calls | 2,009 |
| Input | 13,629,456 |
| Cached input | 6,874,368 |
| Uncached input | 6,755,088 |
| Visible output | 2,387,148 |
| Visible total | 16,016,604 |

The DeepSeek billing view showed these components:

| Billing component | Tokens |
| --- | ---: |
| Input, cache hit | 8,135,424 |
| Input, cache miss | 6,173,130 |
| Output, including reasoning | 14,857,288 |

Those three copied components sum to **29,165,842**, while the copied dashboard
headline was **29,765,842**—a 600,000-token discrepancy. Preserve both values in
the incident record rather than forcing them to agree. The component figures
are the basis of the cost calculation.

Using the Saturday prices shown by DeepSeek on that date—¥0.05/M cache-hit
input, ¥1.50/M cache-miss input, and ¥4.50/M output—the components calculate to:

```text
8.135424 × ¥0.05 + 6.173130 × ¥1.50 + 14.857288 × ¥4.50
= ¥76.524262
```

This agrees with the observed spend of roughly ¥70-plus.

## Why the Hindsight trace looked cheaper

Hindsight 0.8.6's OpenAI-compatible provider subtracts
`completion_tokens_details.reasoning_tokens` from its reported output and total
before writing the trace. It records visible answer tokens, not the full
billable output of a thinking model.

The provider's billed output exceeded the trace's visible output by
**12,470,140 tokens** in this snapshot. Hindsight traces remain useful for call
and bank attribution, but the provider billing console is the cost authority.

Source: [Hindsight 0.8.6 OpenAI-compatible token accounting](https://github.com/vectorize-io/hindsight/blob/v0.8.6/hindsight-api-slim/hindsight_api/engine/providers/openai_compatible_llm.py#L985-L1029).

## Workload attribution

Attribution from the visible Hindsight traces was:

- official coding-agent repository banks: **67.37%** of visible tokens;
- their first-time retain/consolidation subset: about **59.4%** of all visible
  tokens;
- legacy `coding-agent::workspace`, used mostly by the OpenClaw manual
  backfill: **29.88%**;
- `yuki-memory`: **2.22%**;
- old bank `845849177`: **0.53%**.

The ranking is useful, but these are not exact shares of billed currency: the
0.8.6 trace does not preserve per-bank reasoning-token totals. The coding-agent
cold build was the largest source; the 20-document, 327-retain-call OpenClaw
backfill plus its consolidation was the second.

## Operating policy

- Choose the Hindsight server's provider before enabling automatic seed/deepen
  across many repositories. The caller's own model does not reroute Hindsight
  extraction or consolidation.
- For the next cold build, use the subscription bridge and target Luna (using
  the exact model identifier accepted by the managed account).
- Estimate historical imports on a small approved sample. A "dry-run" that
  calls retain or reprocess still spends tokens.
- Keep coding and companion banks separate so trace attribution and policy are
  understandable.
- Expect steady-state costs after cold start: new long sessions,
  reconsolidation, reprocessing, mental models, and knowledge pages can still
  invoke models.

The planned provider route is documented in
[Hindsight 0.9.2 and the Codex bridge](hindsight-openai-responses-bridge.md).

## Pricing source

- [DeepSeek API pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
