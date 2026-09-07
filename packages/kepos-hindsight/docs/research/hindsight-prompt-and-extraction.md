# Prompt, mission, strategy, and extraction modes

Hindsight has several independent prompt surfaces. Treating them as one global
"memory prompt" makes it easy to tune the wrong stage.

## Configuration surfaces

| Stage | Surface | Effect |
| --- | --- | --- |
| Retain item | `content` | Source data to extract; not a prompt setting |
| Retain item | `timestamp` | Lets extraction resolve relative dates |
| Retain item | `context` | Direct attribution/source cue injected into extraction |
| Retain item | `metadata` | Included in extraction and stored with recalled memories |
| Retain request | `strategy` | Selects a named bank strategy; otherwise the default applies |
| Fact extraction | `retain_mission` | Focuses extraction alongside the built-in rules; ignored by `chunks` |
| Fact extraction | `retain_extraction_mode` | Selects `concise`, `verbose`, `custom`, `verbatim`, or `chunks` |
| Fact extraction | `retain_custom_instructions` | Replaces built-in extraction guidelines in `custom` mode |
| Strategy resolution | `retain_strategies` / `retain_default_strategy` | Overlays mission, mode, chunk sizes, labels, and custom instructions |
| Consolidation | `observations_mission` | Replaces the definition used to synthesize durable observations |
| Reflect | `reflect_mission` | Identity and reasoning frame for reflect only |
| Reflect | dispositions and directives | Soft style controls and hard reflect rules |
| Mental models | `source_query` | Durable question used to maintain a synthesized knowledge page |
| Recall | query, budgets, types, tags, token limits | Retrieval controls; there is no bank-level `recall_mission` |

The calling integration owns the automatic-recall preamble and boundary. Bank
configuration controls what was stored and how reflect reasons, not how DSH
labels the injected recall block.

## Extraction modes

| Mode | LLM extraction | Practical meaning |
| --- | --- | --- |
| `concise` | Yes | Selective long-term facts. Cheap relative to verbose, but stock examples deliberately omit some seemingly trivial preferences, which is risky for a companion. |
| `verbose` | Yes | Rich, exhaustive extraction. Useful for audits or a small migration sample, but creates more facts, tokens, consolidation work, and noise. |
| `custom` | Yes | Replaces built-in extraction guidelines while retaining Hindsight's structural schema, temporal handling, and coreference machinery. Best fit for the companion bank. |
| `verbatim` | Yes | Preserves raw chunk text as the fact, but still uses an LLM for metadata, entities, attribution, and time. It is not a no-LLM mode. |
| `chunks` | No | Stores chunks without fact extraction. Useful as an archive/RAG source, but does not produce the normal fact graph or fact-driven observations. |

`retain_mission` still matters in `custom` mode. Custom instructions define
*how* to extract; the mission defines *what the bank is trying to remember*.

## Companion prompt responsibilities

### `retain_mission`: what belongs

The mission should explicitly include:

- facts about Neil's world, commitments, plans, people, and places;
- both parties' likes **and dislikes**, including food, activities, desired
  trips and meals, films, games, books, authors, and visual/artistic styles;
- memorable relationship episodes: affectionate, funny, warm, vulnerable,
  jealous, tense, argumentative, reconciliatory, or symbolically important;
- exact phrases, nicknames, in-jokes, rituals, promises, boundaries, and open
  threads when their wording carries the memory;
- changing or temporary wants with a timestamp and lower durability unless
  they became an important shared interaction.

### `retain_custom_instructions`: how to encode it

Prefer faithful episode cards over interpretation. Preserve enough of the
surrounding exchange to retain what happened, who said what, how the other
party responded, and whether the moment was repaired or left unresolved. Keep
short representative quotations when the language itself is meaningful.

Do not turn a quote into unsupported psychology such as "this proves Neil is
avoidant." Separate observation from inference, label dreams/fiction/role-play
and hypotheticals, and preserve uncertainty. Relationships with real third
parties need especially careful provenance. By contrast, an interaction
between Neil and Yuki can retain Yuki's attributed words, actions, and feelings
without requiring a second confirmation that Yuki "really" felt them.

Exclude system/developer prompts, heartbeat-only sessions, cron boilerplate,
tool calls and outputs, injected recall text, runtime time banners, and copied
transcript plumbing. These are operating artifacts, not relationship memory.

### `observations_mission`: what becomes a pattern

Observations should synthesize stable preferences, repeated care or friction
patterns, durable boundaries, recurring interests, and meaningful changes over
time. Do not use consolidation to flatten a vivid one-off episode into a vague
personality claim. Temporary cravings or moods stay dated and low-weight unless
they recur or become an important interaction.

### `reflect_mission`: how to reason with memory

Reflect should produce an evidence-grounded first-person briefing, distinguish
current from historical state, quote the source when wording matters, and make
uncertainty explicit. It should not invent continuity to fill a gap.

## Ownership and versioning

The DSH plugin deliberately sends no named strategy and should not embed these
missions. The deployment source of truth is the workspace-owned file:

```text
~/.openclaw/workspace/hindsight/yuki-memory.bank.json
```

The server's live bank configuration is the deployed result, not the only copy.
Plugin upgrades therefore cannot silently replace the companion policy. Keep a
prompt version or change note with the workspace file so historical documents
can be reprocessed deliberately after a material extraction-policy change.

## Limits

A complete raw session document does not guarantee complete recallable facts.
Extraction can legitimately return zero or omit a subtle episode, especially
under a narrow mission. Keeping `store_document_text` enabled preserves the
ability to reprocess, but reprocessing invokes the LLM again and has real cost.

## Sources

- [Retain API](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/api/retain.mdx)
- [Retain guide](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/retain.md)
- [Retain configuration and named strategies](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/docs/developer/configuration.md)
- [Personal Assistant template](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/data/templates/personal-assistant.json)
