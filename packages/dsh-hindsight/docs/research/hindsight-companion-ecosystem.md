# Companion-agent ecosystem references

Research snapshot: 2026-08-29. These references establish lifecycle and
integration precedent; none is a drop-in substitute for the Yuki companion
retention policy.

## Official companion and per-user recipes

Hindsight's [Per-User Memory recipe](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/pages/cookbook/recipes/per-user-memory.md)
explicitly lists **Personal AI companions** as a fit. It uses one bank per user,
recall before a response, and one complete conversation document whose stable
`document_id` is updated as the session grows.

The official
[`personal-assistant.json`](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/data/templates/personal-assistant.json)
retains preferences, routines, commitments, important people, and their
relationships to the user. It also defines User Profile, Routines & Schedule,
and Active Tasks & Commitments mental models and supplies reflect directives.
This is direct precedent for making relationships an explicit policy rather
than hoping a generic coding mission infers them.

The older [Personal AI Assistant recipe](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/src/pages/cookbook/recipes/personal_assistant.md)
also demonstrates every-turn recall and post-response retain for family, work,
preferences, routines, and goals.

These examples do not prove that stock concise extraction will retain every
meaningful quote or emotional episode. Hindsight can preserve raw document text
while extracting zero facts under a narrow mission.

## Huanshi

[`CN-PlayerYe/huanshi`](https://github.com/CN-PlayerYe/huanshi) is a local-first
private assistant/companion application with personalities. Its published
feature set includes Hindsight memory, per-persona memory and style, voice,
images, scheduled outreach, and a phone-accessible LAN web UI.

Its [Hindsight backend](https://github.com/CN-PlayerYe/huanshi/blob/main/server/memory/hindsight.ts)
uses the official TypeScript SDK. It creates persona-specific banks, recalls
before chat, injects results as non-authoritative background, retains a
conversation experience asynchronously after the reply, and exposes an
explicit reflect action. It also uses caller `context` to distinguish a user
preference/fact from a conversation experience.

This validates the overall loop, but Huanshi currently retains one generated
summary per response instead of a complete session document and uses a generic
personal-continuity mission. It does not solve the exact-quote and
relationship-episode requirements by itself.

## Hermes and OpenClaw lifecycle precedent

The [official Hermes integration announcement](https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/blog/2026-04-06-hermes-native-memory-provider.md)
describes relevant recall before every turn, background retain after every
response, and a hybrid mode that combines automatic injection with explicit
retain/recall/reflect tools. This is a strong lifecycle fit for a messaging
agent, but its published default is not a Yuki-specific relationship policy.

[`jscholz/hermes-agent-workflow`](https://github.com/jscholz/hermes-agent-workflow)
provides an independent self-hosted personal-assistant stack with a
phone-oriented PWA, voice bridge, encrypted snapshots, and a Hindsight bank
dump. Its example enables automatic recall and asynchronous retain every turn;
the persona remains in `SOUL.md` rather than a custom Hindsight extraction
prompt.

The official OpenClaw/Hermes style of integration demonstrates that automatic
memory and deliberate tools can coexist. For DSH, the useful combination is:

- automatic raw recall on every direct message;
- ordered background retain after each completed exchange;
- one explicit Reflect tool when Yuki deliberately thinks across shared history;
- bank and prompt configuration owned outside the plugin.

The DSH plugin intentionally omits multi-agent and coding strategy behavior.
Its session-document model and companion prompt are documented separately in
[Session documents and historical backfill](hindsight-session-retain-and-backfill.md)
and [Prompt, mission, strategy, and extraction modes](hindsight-prompt-and-extraction.md).

## Remaining gap

No reviewed public integration published a mature extraction policy that
treats intimate or fictional companion rituals—exact phrases, in-jokes,
symbolic places, jealousy, arguments and repair, and relationship milestones—
as first-class memories with the desired fidelity. That is why this deployment
keeps a custom bank policy and should evaluate it with representative Chinese
conversations rather than relying only on generic examples.
