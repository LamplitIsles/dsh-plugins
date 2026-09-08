# DSH Tabletop

**Roll bounded dice on the DeepSeek Harness Host and use the returned result as the source of truth.**

Call `roll_dice` with structured arguments:

```json
{ "count": 2, "sides": 6, "modifier": 3, "label": "damage" }
```

One possible result:

```json
{ "count": 2, "sides": 6, "rolls": [2, 5], "modifier": 3, "total": 10, "label": "damage" }
```

## Install

Requires Node.js 24+ and DSH `0.1.2-rc.1`. From a built checkout, use DSH's
package manager, then restart the selected profile:

```sh
dsh plugin --profile web add ./packages/dsh-tabletop
```

This package starts at independent version `0.1.0`. Its Cordis bundle registers
exactly one agent tool, `roll_dice`, and requires only the Host `tools` service.
It has no client bundle or settings to configure.

## Tool contract

| Input | Contract |
|---|---|
| `count` | Optional integer from 1 to 100; defaults to 1. |
| `sides` | Required integer from 2 to 1,000,000. |
| `modifier` | Optional integer from −1,000,000 to 1,000,000; defaults to 0; added once to the sum. |
| `label` | Optional string of at most 200 JavaScript string code units, preserved verbatim, including an empty string. |

Unknown fields, dice notation, numeric strings, fractions, nonfinite numbers,
and out-of-range values are rejected before any dice are generated. Defaults
apply to omitted fields; `null` is invalid.

Each die uses unbiased Node `crypto.randomInt(1, sides + 1)`. The structured
result contains `count`, `sides`, `rolls` in draw order, `modifier`, and `total`.
`label` is present only when supplied. The bounds keep every total within the
safe integer range. The model-facing text is JSON of this same result; rendering
does not roll again. A new tool call creates a new roll.

There is no plugin persistence, workspace JSONL, network access, random tables,
cards, character state, or rules engine. DSH owns normal tool-result history.

## Development

From the workspace root:

```sh
corepack pnpm --filter @lamplitisles/dsh-tabletop run typecheck
corepack pnpm --filter @lamplitisles/dsh-tabletop run test
corepack pnpm --filter @lamplitisles/dsh-tabletop run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-tabletop run pack-smoke
```

The core accepts an injected draw function for deterministic tests. The packed
smoke installs into a temporary DSH home, activates the package through the real
Cordis Loader and tools service, exercises a roll, and verifies unload cleanup.

## License

[Apache-2.0](LICENSE).
