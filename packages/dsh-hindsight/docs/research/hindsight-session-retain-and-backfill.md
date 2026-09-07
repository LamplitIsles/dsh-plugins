# Session documents and historical backfill

## One stable document per session

The companion integration should model a session as one Hindsight document,
not create one document for every turn.

The required behavior is:

1. Derive a stable `document_id` from the DSH session.
2. On the first persist, store the complete transcript available at that point.
3. On later turns, append only new JSONL dialogue events to the same document,
   in session order.
4. Serialize writes for the same session even when retain is asynchronous.
5. Flush or surface pending failures when the session ends.

This gives Hindsight a complete episode source while avoiding repeated
replacement and re-extraction of an ever-growing transcript. It matches the
official per-user recipe's semantic boundary—one document per conversation—
while using append for incremental operation.

The retained JSONL should contain human/assistant dialogue and stable event
identity. It should exclude tool traffic, injected memory, system/developer
instructions, heartbeat-only prompts, runtime time banners, and duplicate
cumulative histories.

## Raw document versus recallable memory

Stored document text is the lossless reprocessing source. Recall searches the
facts and observations extracted from it; merely seeing the complete text in a
document does not mean a subtle quote or relationship moment became a fact.

This distinction explains failures such as a meaningful episode being present
in an OpenClaw session but absent from recall. Correct handling is:

- preserve the original session document;
- improve the companion mission/custom extraction rules;
- reprocess only the affected documents, or retain a curated historical
  episode with provenance;
- verify the resulting fact/observation and recall behavior.

Do not replace a full historical source document with a hand-curated excerpt.
Use a separate deterministic ID such as `historical-episode::<source>::<id>` so
the excerpt supplements rather than destroys the source.

## Selecting historical input

Do not feed every old OpenClaw record into Hindsight indiscriminately. Early
configuration mistakes produced sessions containing only heartbeat prompts,
system scaffolding, or repeated cumulative history. Build a review-only input
manifest first and sample the actual dialogue.

Prioritize sessions with clear user/assistant exchanges and retain:

- stable facts, plans, commitments, people, and places;
- positive and negative preferences from both sides;
- exact memorable phrases and complete emotional episodes;
- conflicts together with their aftermath or repair;
- relationship milestones, rituals, symbols, promises, and unfinished threads.

Deduplicate forks and cumulative exports using stable event/message identity
and timestamps before submitting documents. Record source session IDs and
message boundaries as metadata so a later audit can trace every extracted
memory to its origin.

The current workspace keeps migration material under:

```text
~/.openclaw/workspace/hindsight/backfill/
```

The manifest should remain explicitly review-only—no retain authorization—until
the selected input has been inspected and approved.

## Cost and batching

A read-only transcript scan that does not call Hindsight can be free of model
cost. Hindsight `retain`, document reprocessing, reflect-assisted curation, and
observation consolidation invoke model providers and are not free dry-runs.

Batching is still useful for bounded retries, cost measurement, and rollback,
but does not inherently reduce extraction tokens. Estimate with a small,
representative approved batch, inspect facts and observations, then continue.
See [Cold-start token cost and billing](hindsight-cold-start-costs.md).

## Sources

- [Per-user memory recipe](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/pages/cookbook/recipes/per-user-memory.md)
- [Retain document update modes](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/api/retain.mdx)
