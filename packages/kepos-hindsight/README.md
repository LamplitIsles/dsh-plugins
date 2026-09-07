# kepos-hindsight

A small [Hindsight](https://github.com/vectorize-io/hindsight) adapter for a
companion-style DSH agent. It replaces only DSH's official *coding-agent*
adapter. Codex can keep using the official coding-agent hooks and the same
`~/.hindsight/coding-agent.json` file.

The package targets the exact DSH `0.1.2-rc.1` Host and Web client contract;
use a matching rc.1 DSH runtime when installing it as a bundle.

## What it does

- Runs raw Hindsight recall on every direct user turn, with the current message
  and a small amount of prior user context.
- Injects one Hindsight context on every direct turn: the host's current local
  time is authoritative, while recalled facts remain explicitly untrusted
  historical context. Retrieval failures time out and never block a reply.
- Retains into one stable Hindsight document per session: `dsh:<session-id>`.
  The first completed turn after DSH starts replaces it with the full available
  session transcript; later turns append only their JSONL delta.
- Exposes one deliberate read-only tool: `hindsight_reflect`, for bank-defined
  synthesis across multiple memories when the automatically supplied raw facts
  and current conversation cannot answer the question.

It does **not** seed a codebase, create knowledge pages, auto-reflect, import
a bank template, or enable subagents.

## Why not use the official coding-agent integration?

The official integration treats a repository or worktree as the durable thing:
it surveys code, retains coding sessions, maintains knowledge pages, recalls
past decisions, and exposes project-oriented tools. That is a good fit for an
engineering agent, but it is the wrong identity and lifecycle for one companion
continuing across unrelated conversations and workspaces.

This adapter changes the product contract rather than merely changing a prompt:

| Concern | Official coding-agent integration | This companion adapter |
| --- | --- | --- |
| Durable identity | Repository/workspace | One user-selected relationship bank |
| Automatic retrieval | Coding knowledge, initial synthesis, and page guidance | Raw, non-LLM recall before every direct user turn |
| Repetition | Coding lifecycle decides when synthesis/guidance is useful | Every result remains eligible on every relevant turn; no cross-turn suppression |
| Retention | Coding sessions, repository facts, Git/doc strategies | Clean user/assistant dialogue in one repairable document per chat session |
| Reflect | Part of the coding knowledge workflow | Deliberate explicit tool for questions that need synthesis |
| Tools | Knowledge pages, project search/capture/ingest, Reflect | One read-only `hindsight_reflect` tool |
| Routing | Workspace-derived banks | Workspace, CWD, and preset never reroute the selected bank |
| Policy ownership | Ships coding missions and strategies | Sends no strategy or mission; the bank owner defines companion memory policy |
| Agent topology | Supports coding-agent and subagent workflows | Direct companion sessions only; subagents are excluded |

The practical result is continuity without coding-agent overhead: inexpensive
retrieval runs each turn, the full source dialogue is submitted as a stable
session document, and expensive Reflect synthesis happens only when requested.

See [Companion memory design](docs/companion-memory-design.md) for the lifecycle,
failure semantics, prompt boundary, and the design principles behind these
choices.

## Bank strategies and prompts

The adapter has no opinion about the bank's `retain_mission`,
`observations_mission`, or `reflect_mission`.

It never calls `/import`, does not send a Hindsight `strategy`, and does not
send a retain `context`. Configure those missions in Hindsight for the target
bank, through its normal UI or bank-config API. This keeps each companion's
memory policy entirely user-owned and prevents a DSH plugin update from
overwriting it.

The short wrapper around recalled facts is a prompt-injection boundary, not a
Hindsight strategy: recalled history is evidence, never an instruction. The
clock is generated locally for the current turn, travels in the same context,
and is excluded from the retained transcript.

## Install as a local DSH bundle

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/kepos-hindsight run build
dsh plugin --profile web add file:/absolute/path/to/dsh-plugins/packages/kepos-hindsight
```

The bundle mounts `kepos-hindsight`. It does not alter the official Codex
integration. Confirm the composition before starting DSH:

```bash
dsh --profile web --dump-config
```

The output should include an enabled `kepos-hindsight` row. A running DSH host
must be restarted after changing its bundle list.

For a published release, install the public package directly:

```bash
dsh plugin --profile web add @lamplitisles/kepos-hindsight
```

## Configuration

Endpoint, credentials, per-bank missions, and the global `disabled` flag stay
in the normal shared Hindsight config, `~/.hindsight/coding-agent.json`.

Choose the DSH companion bank at **Settings → Plugins → Hindsight memory**.
It defaults to `yuki-memory`. This is the only routing choice: a
DSH agent, its preset, its workspace, and the current working directory never
select or remap the bank. The chosen bank is used by automatic recall,
asynchronous retain, and `hindsight_reflect` alike.

Saving is a live DSH setting and applies on the next turn. DSH intentionally
allows Settings RPC writes only from its loopback Web UI, so change it on the
host rather than through a Kepos-proxied mobile connection.

The optional `harnesses.dsh.companion.recall` extension tunes retrieval only;
it does not choose a bank or add a recall/retain switch. The official
coding-agent adapter ignores this extension.

```json
{
  "harnesses": {
    "dsh": {
      "companion": {
        "recall": {
          "budget": "low",
          "maxTokens": 900,
          "types": ["observation", "world", "experience"],
          "preferObservations": true,
          "topK": 3,
          "contextTurns": 2,
          "maxQueryChars": 800,
          "timeoutMs": 4000
        }
      }
    }
  }
}
```

This example is optional: the values shown are the defaults. `low` recall is
retrieval rather than a Reflect LLM request. Raise its budget only after
checking that a real conversation needs broader retrieval. Automatic recall
and retain deliberately have no UI controls; the global Hindsight `disabled`
and `retainSessions` settings remain their shared service-level safeguards.

## Yuki lives in DSH live config

This repository deliberately ships no Yuki persona or preset. Create and keep
the preset locally under `$DSH_HOME/.agent-presets/yuki/`, preferably by copying
DSH's current `standard` preset through DSH's preset UI and then editing the
copy. Disable or remove its `delegation` group for a single-session companion. The
workspace's own `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md` remain the
source of truth for personality and relationship behavior.

## Development and packed verification

Run the package checks from the workspace root. The tests use fake Hindsight
HTTP responses and test-owned temporary config directories, so they never read
or modify a live bank:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/kepos-hindsight run typecheck
corepack pnpm --filter @lamplitisles/kepos-hindsight run test
corepack pnpm --filter @lamplitisles/kepos-hindsight run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/kepos-hindsight run pack-smoke
```

The packed smoke installs the artifact into a disposable DSH `0.1.2-rc.1` Web
profile, verifies Settings and the Web bootstrap, and loads the client through
the real Loader.

## Independent release

Prepare only this package and an exact matching tag from the workspace root:

```bash
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/kepos-hindsight v0.1.0 .release-artifacts/kepos-hindsight
```

After reviewing the verified tarball, publish it separately with existing npm
credentials at the registry boundary:

```bash
npm publish .release-artifacts/kepos-hindsight/lamplitisles-kepos-hindsight-0.1.0.tgz \
  --access public --tag latest
```

Versions remain independent across the workspace. Release preparation does not
publish, deploy, provision npm trust, or manage credentials; use `og` for
Forgejo operations.

## Design and operating notes

The [companion-memory notes](docs/research/hindsight-companion-memory.md) cover
the coding/companion boundary, prompt and extraction policy, session backfill,
cold-start cost, reranking, provider migration, and related integrations.
