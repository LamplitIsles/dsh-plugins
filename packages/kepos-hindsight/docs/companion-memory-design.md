# Companion memory design

`kepos-hindsight` is a memory-lifecycle adapter for a persistent companion. It
is not a persona, a relationship prompt, or a general replacement for
Hindsight's official coding-agent integration.

The distinction matters because the two products preserve different things:

- a coding agent preserves knowledge about a repository and the work performed
  in it;
- a companion preserves continuity between two participants across changing
  topics, sessions, devices, presets, and working directories.

This document describes the companion-specific contract, what differs from the
official integration, and which responsibilities intentionally remain outside
the plugin.

## Product comparison

The [official coding-agent integration](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents)
is organized around repository knowledge. Depending on the host and selected
features, it can survey a codebase, retain coding sessions, synthesize initial
context, maintain knowledge pages, capture initiatives, and expose tools for
searching or extending that project knowledge.

Those capabilities are useful precisely because a code repository is the unit
of continuity. A new workspace may need a different bank; repeated social
detail is usually noise; a synthesized project briefing is often more useful
than recalling raw dialogue on every message.

The companion adapter makes the opposite choices where the domain requires it:

| Dimension | Coding-agent design | Companion design |
| --- | --- | --- |
| Continuity boundary | Repository or worktree | One explicit relationship bank |
| Typical source material | Code, Git history, documents, coding sessions, decisions | Direct dialogue, preferences, plans, relationship episodes, exact phrases |
| Automatic retrieval cadence | Coding lifecycle and project-goal oriented | Every eligible direct user turn |
| Automatic retrieval method | Project synthesis and knowledge guidance | Raw Hindsight recall; no Reflect LLM on the automatic path |
| Client-side result suppression | Coding workflow controls synthesis cadence | None: a still-relevant memory may be injected on consecutive turns |
| Session storage | Coding-session/project knowledge | One stable JSONL dialogue document per DSH session |
| Synthesis | Useful automatically for project orientation | Explicit `hindsight_reflect`, reserved for pattern or retrospective questions |
| Model-facing tools | Broad project knowledge surface | One read-only Reflect tool |
| Bank routing | Derived from project/workspace context | Chosen explicitly in DSH Settings and unaffected by workspace |
| Subagents | Part of supported coding workflows | Excluded so delegated work cannot become relationship memory |
| Memory policy | Coding missions, strategies, and page rules ship with the integration | Bank-owned missions and extraction rules; the plugin never overwrites them |

This is not a claim that companion memory is universally better. It is a
narrower contract for a different durable entity.

## Runtime lifecycle

### Before every direct user turn

The adapter builds a bounded query from the current user message and a small
amount of recent user context. It performs Hindsight `recall` with a low,
retrieval-specific budget and injects the ranked/top-K results into the current
turn.

Recall is intentionally:

- **per-message**, because a companion conversation can change topic within one
  session and the relevant past may change with it;
- **raw and non-LLM**, because every-turn Reflect would add avoidable cost and
  latency;
- **unsuppressed across turns**, because a preference or relationship fact can
  remain relevant throughout a follow-up exchange;
- **fail-open**, because an unavailable memory service must not prevent the
  companion from replying.

The injected block also contains the host's current local time. This helps the
model distinguish current state from dated memories and relative phrases such
as “yesterday” or “recently.” Recalled material is marked as historical evidence,
not as instruction, so stored text cannot silently become a higher-priority
prompt.

### After every completed turn

The adapter retains only clean direct user/assistant dialogue. Tool traffic,
plugin-injected recall, clock banners, and runtime plumbing are excluded so the
bank does not later attribute operational text to either participant.

Each DSH session owns one stable Hindsight document:

1. the first successful retain after process start replaces the document with
   the full available session transcript;
2. later completed turns append only their JSONL delta;
3. retain submissions for one session are serialized;
4. if an append acknowledgement fails, the next completed turn repairs the
   document with a full replacement before append resumes;
5. deterministic operation IDs are scoped to the bank, document, turn, update
   mode, and content, so an exact retry is idempotent while identical words in
   two distinct turns are not collapsed.

Keeping the source document matters even when extraction misses something. If
Hindsight document-text storage is enabled and the bank's prompts improve
later, stored session text can be deliberately reprocessed instead of
reconstructing the relationship from incomplete facts.

### Explicit tools

The model receives only `hindsight_reflect`, for deliberate synthesis across
multiple memories. A system-prompt guideline tells it that raw memories are
already supplied automatically and frames Reflect as a companion deliberately
thinking across shared history, not as an analyst profiling the user. It is for
invited look-backs and multi-episode questions about change, recurring dynamics,
milestones, promises, boundaries, unfinished threads, rupture, or repair. It
explicitly excludes ordinary affection and empathy, single facts or preferences,
and memory performance. Psychological interpretations require a user invitation
and grounding in remembered events; diagnoses and hidden motives are never
presented as fact.

The tool participates in DSH's cooperative cancellation contract. Reflect has
a 330-second outer tool budget around the deployed server's 300-second LLM
budget, leaving room for transport and response handling while still producing
DSH's structured timeout result.

No knowledge-page, initiative-capture, codebase-seeding, document-ingest, or
write tool is exposed. The automatic session-retain path is the sole writer.

## Design philosophy

### 1. Preserve the relationship, not the workspace

The bank is selected explicitly and remains stable across CWD, workspace, and
agent preset changes. Filesystem location is useful identity for code; it is
accidental identity for a companion.

### 2. Source completeness before clever client heuristics

The plugin preserves the full clean session transcript and injects every result
Hindsight chose for the current query. It does not invent a second memory layer,
semantic deduplicator, or sliding “recently seen” cache. Consolidation,
observation preference, ranking, and top-K belong to Hindsight, where they can
be improved without losing source material.

### 3. Cheap automatic continuity; expensive reasoning by intent

Raw recall is appropriate on every meaningful message. Reflect is valuable for
questions such as “what pattern has developed between us?”, but paying for it on
every turn would increase latency and LLM cost while replacing concrete evidence
with repeated synthesis.

### 4. Correct retention over superficial availability

Recall may fail open because it is supplementary to the current reply. Retain
must acknowledge submission and preserve a repair path because silently losing
a turn damages future continuity. These are different failure contracts and are
implemented separately.

### 5. Minimal model surface

Every additional tool consumes prompt space and gives the model another action
to choose. A companion needs ordinary recall and occasional synthesis, not the
official integration's project-maintenance toolset.

### 6. Prompts belong to the relationship owner

The plugin sends no named retain strategy, retain context, or built-in companion
mission. It never writes `retain_mission`, `retain_custom_instructions`,
`observations_mission`, or `reflect_mission`.

That separation prevents a plugin upgrade from silently redefining what a
relationship means or what deserves to be remembered. The target bank can be
configured to retain, for example:

- both participants' likes and dislikes;
- plans, commitments, people, places, and changing temporary wants;
- affectionate, funny, warm, vulnerable, jealous, tense, argumentative, and
  repaired episodes;
- exact phrases, nicknames, in-jokes, rituals, promises, boundaries, and open
  threads when their wording matters;
- careful provenance and uncertainty, especially for relationships involving
  real third parties.

Those are authoring recommendations, not defaults embedded in runtime code. The
repository deliberately does not ship a universal romance prompt: different
companions and users need different identities, boundaries, and relationship
models. See [Prompt, mission, strategy, and extraction modes](research/hindsight-prompt-and-extraction.md)
for a prompt-surface guide.

### 7. Persona, memory policy, and transport are separate layers

The companion's voice and relationship stance belong in its normal persona or
workspace instructions. Hindsight bank prompts decide what to extract,
consolidate, and synthesize. This plugin decides when and where recall/retain
happen. Keeping these layers separate makes each independently replaceable and
prevents memory plumbing from becoming persona truth.

## What the adapter deliberately does not do

- It does not define whether the participants are romantic, platonic,
  exclusive, non-exclusive, fictional, or role-playing.
- It does not promise that every retained sentence becomes an extracted fact;
  Hindsight extraction remains probabilistic and may be reprocessed.
- It does not make Reflect part of the ordinary response path.
- It does not use the workspace to choose a bank.
- It does not retain subagent sessions.
- It does not replace Hindsight's observation, ranking, or reranking systems.
- It does not deploy or configure the Hindsight server.

## Related design and operating notes

- [Coding-agent memory versus companion memory](research/hindsight-coding-vs-companion.md)
- [Prompt, mission, strategy, and extraction modes](research/hindsight-prompt-and-extraction.md)
- [Session retain and historical backfill](research/hindsight-session-retain-and-backfill.md)
- [Companion-agent ecosystem references](research/hindsight-companion-ecosystem.md)
- [Recall reranking](research/hindsight-reranking.md)
