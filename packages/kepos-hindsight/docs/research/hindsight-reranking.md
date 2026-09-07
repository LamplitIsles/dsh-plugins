# Reranking: local cross-encoder versus RRF

## Observed behavior

With Hindsight 0.8.6's local cross-encoder on the CPU-only deployment, a recall
against the large companion bank took about 28 seconds from the caller's point
of view and could exceed DSH's tool timeout.

After setting the server-wide provider to RRF:

```text
HINDSIGHT_API_RERANKER_PROVIDER=rrf
```

observed recalls were primarily about 0.1–0.3 seconds, with a maximum around
0.68 seconds in the inspected sample. These numbers describe this deployment,
not a universal benchmark.

## What each method does

The local provider uses a cross-encoder such as
`cross-encoder/ms-marco-MiniLM-L-6-v2`. It jointly scores each query/candidate
pair after initial retrieval. This can improve semantic top-result ordering,
but inference cost grows with the candidate batch and is sensitive to CPU,
model language/domain, and concurrency. The stock MS MARCO model's benefit for
Chinese companion dialogue is not established merely because it is the
default.

RRF—reciprocal rank fusion—combines the rank positions already produced by the
retrieval arms. Hindsight's `rrf` reranker is effectively the lightweight
passthrough/fusion path: it adds no neural pair scoring, is deterministic, and
does not call an LLM.

Recall does not rerank every memory in the bank. Initial retrieval produces a
bounded candidate set, so latency does not grow linearly with all stored
memories. A CPU cross-encoder can nevertheless be slow on that bounded batch;
candidate count, batch size, and concurrent requests still matter.

## Scope of the environment variable

`HINDSIGHT_API_RERANKER_PROVIDER` is server-wide. It affects automatic
companion recall. Reflect also performs retrieval internally, so its retrieval
stage uses the same provider. This is not a per-request quality switch in the
current deployment.

## Decision

Use RRF for now. Every-turn companion recall values bounded latency and service
stability more than an unmeasured English cross-encoder gain. Explicit Reflect
remains available when the task needs deeper synthesis.

Reconsider a neural reranker only after testing a multilingual remote/GPU
backend against a small golden set of real Chinese companion queries. The test
must show a meaningful recall-ordering gain within the latency budget; provider
availability alone is not a reason to change.
