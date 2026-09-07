# Coding-agent memory versus companion memory

The official Hindsight coding-agent integration and the DSH companion adapter
share a storage engine, but they should not share a bank or retention policy.
Their identity, source material, latency budget, and definition of a useful
memory are different.

## Comparison

| Concern | Official coding-agent integration | DSH companion integration |
| --- | --- | --- |
| Identity boundary | Repository/worktree | One continuing companion relationship |
| Bank | Normally one `coding-agent::<workspace>` bank per repository | Dedicated `yuki-memory` bank |
| Cold start | Seeds git history and a codebase survey, then deepens new material | Does not seed a repository; historical chat is a separate curated migration |
| Primary sources | Commits, codebase survey, coding sessions, knowledge pages | Direct dialogue, relationship episodes, preferences, plans, and raw session transcripts |
| Retain policy | Named `git`, `gitlog`, `conversation`, and `document` strategies | Top-level companion policy; the adapter sends no strategy |
| Conversation goal | Final implementation state and developer-relevant decisions | Personal continuity, exact attribution, emotional episodes, mutual preferences, and open threads |
| Write cadence | Session/Stop lifecycle plus repository deepening | Ordered asynchronous updates to one stable document per DSH session |
| Automatic retrieval | First-prompt reflect and generated knowledge pages | Raw recall on every direct user turn |
| Deliberate retrieval | Recall/reflect tools and knowledge pages | Reflect only for deliberate cross-memory synthesis |
| Acceptable omission | Social detail is usually noise | Vivid, warm, funny, jealous, tense, or repaired moments can be the point |

## Why separate banks matter

The official coding-agent integration creates and re-applies named strategies
for its own writes. Its `conversation` strategy uses `verbose` extraction and
a developer-focused mission that prioritizes the final technical state. Its
template also defaults a newly created coding bank to the `git` strategy.

An explicit retain `strategy` overlays the resolved bank configuration,
including `retain_mission`, extraction mode, labels, and custom instructions.
Therefore a companion top-level mission cannot protect a write made with the
coding `conversation` strategy: that request deliberately uses the coding
policy. A distinct `yuki-memory` bank prevents both accidental strategy
selection and later coding-agent maintenance from reshaping companion memory.

Codex should continue using the official integration in arbitrary coding
workspaces. DSH should use only the companion adapter for `yuki-memory`; the
official coding-agent plugin must not open or maintain that bank.

## Recall, retain, and reflect are different operations

- **Retain** turns submitted source text into facts and later observations. It
  is a write path and may invoke extraction and consolidation LLMs.
- **Recall** retrieves stored facts/episodes for a query. The current companion
  loop uses it on every direct user message because the relevant memory can
  change from turn to turn.
- **Reflect** performs a slower, evidence-grounded synthesis over recalled
  material. It is useful for questions such as how a relationship pattern
  changed over time; it should not be the default every-turn retrieval path.

Current time can be injected beside recalled memory in the caller's context.
That is runtime orientation, not durable conversation content, and should not
be appended to the retained session transcript.

## Sources

- [Official coding-agent missions and strategies](https://github.com/vectorize-io/hindsight/blob/main/hindsight-integrations/coding-agents/src/core/missions.ts)
- [Official per-user memory recipe](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/pages/cookbook/recipes/per-user-memory.md)
- [Memory-bank configuration](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/api/memory-banks.mdx)
