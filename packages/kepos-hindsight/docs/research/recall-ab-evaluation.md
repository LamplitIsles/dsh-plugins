# Raw recall A/B evaluation

`scripts/recall-eval.mjs` compares the current three-type recall with
observation-only and observation-plus-experience. It also derives exact-deduped
variants without issuing extra requests.

Two diagnostic variants also discard graph/temporal-only candidates and rank
the remaining results by the semantic retrieval score already returned by
Hindsight. These do not add another embedding model; they test whether the
existing semantic arm is more useful than the configured RRF final order.

The evaluator is read-only. It never retains, updates, or deletes a memory. By
default it emits hashes, types, scores, counts, and aggregate metrics without
printing query text, memory text, or source document IDs. Pass `--details` only
for an ephemeral local review whose destination is access-controlled.

Input is JSON:

```json
{
  "cases": [
    {
      "id": "nickname-origin",
      "query": "synthetic query",
      "recallExpected": true,
      "queryTimestamp": "2026-09-03T10:00:00+08:00",
      "gold": [
        { "label": "expected memory", "terms": ["synthetic marker"] }
      ],
      "unwanted": [
        { "label": "unrelated contact", "terms": ["synthetic contact"] }
      ]
    }
  ]
}
```

Run it with:

```bash
pnpm recall:eval -- --queries /access-controlled/path/queries.json
```

Gold and unwanted term matching is a reproducible aid, not a semantic judge.
A case may set `recallExpected` to false when its current-session context is
already sufficient or the question needs general knowledge rather than
personal memory. The report then measures whether a variant correctly returns
nothing instead of forcing historical context into the turn.
A person familiar with the conversation must review ambiguous results. Do not
commit real companion queries, memory text, or detailed output to this
repository.

Replaying an old query against today's complete bank leaks future knowledge
into the result. Such a replay is suitable for comparing duplicate and current
relevance behavior across variants, but not for claiming historical accuracy.
Use a test-owned bank populated chronologically to measure consolidation lag,
cross-session freshness, and latest-fact precedence.
