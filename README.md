# dsh-plugins

**Eight independently installable DeepSeek Harness plugins—companion UI, email, Matrix, speech, memory, image generation, dice rolling, and the Nanocodex engine—in one pnpm workspace.**

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
```

The workspace targets Node.js `>=24.11.0`, Corepack pnpm `12.3.4`, and the DSH
`0.1.2-rc.1` contract family (Cordis `4.0.2`, Schemastery `3.18.2`). The
public package identities and versions remain independent.

Enable the Corepack pnpm shim once on a new host, then use plain `pnpm`
commands. The root `packageManager` field remains the version pin:

```sh
corepack enable pnpm
pnpm --version
```

## Packages

| Package                       | Purpose                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@lamplitisles/dsh-companion` | A focused Svelte chat surface at `/companion/`, with durable session and relationship behavior.                                     |
| `@lamplitisles/dsh-mail`      | A single Settings-owned Agent mailbox with six purpose-built mail tools and loopback OAuth.                                         |
| `@lamplitisles/dsh-matrix`    | Matrix room reading, search, and explicit message delivery through DSH tools.                                                       |
| `@lamplitisles/dsh-speech`    | Tagged TTS playback and optional Qwen ASR through an isolated Host service.                                                         |
| `@lamplitisles/dsh-hindsight` | Companion-oriented Hindsight recall, retention, and deliberate reflection.                                                          |
| `@lamplitisles/dsh-imagegen`  | DSH image generation and editing under the active workspace.                                                                        |
| `@lamplitisles/dsh-tabletop`  | Host-only `roll_dice` with structured inputs and unbiased dice rolls.                                                               |
| `@lamplitisles/dsh-nanocodex` | The selected-profile Nanocodex Node/WASM agent engine with guarded DSH tools, raw Add/Update `apply_patch`, and private compaction. |

Imagegen keeps its provider and workspace-boundary core as ordinary internal
modules in the public package; there is no separate private workspace package.

## Workspace commands

Install once from the repository root:

```sh
pnpm install --frozen-lockfile
```

Run the complete local checks in this order:

```sh
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
```

`lint` uses Oxlint's correctness and type-aware rules across the authored
workspace; `format:check` uses Oxfmt for TypeScript, JavaScript, Svelte, CSS
Modules, configuration, and documentation. Neither command launches a browser
or a DSH profile, so use the opt-in Companion browser suite for runtime UI
coverage.

Run one package from the same workspace:

```sh
pnpm --filter @lamplitisles/dsh-mail run test
pnpm --filter @lamplitisles/dsh-mail run build
```

For normal Host development, deploy only the affected package artifacts to the
existing persistent development DSH and restart its service:

```sh
pnpm run dev:deploy -- @lamplitisles/dsh-nanocodex
```

The command reuses the installed rc.1 executable, DSH home, `web` profile,
settings, credentials, and sessions at the host-local `dsh-dev` target. It
does not install DSH, create a new profile, or start a disposable Host. Pass
multiple public package names when one change spans plugins; pass `--all` only
when every public plugin already present in that profile is affected. HTTP
readiness is only a service check, so UI changes still need the task-scoped
browser review. The executable, home, runtime, profile, and service are fixed
to that target; inconsistent `DSH_CLI`, `DSH_HOME`, or `DSH_RUNTIME`
environment overrides fail before build or service mutation. The install child
is explicitly bound to the dev `DSH_HOME`, and the script compares the
installed package bytes (including client, patch, and vendored files) with each
new tarball.

The Companion browser suite is opt-in because it needs Playwright's browser
installation:

```sh
pnpm run test:e2e
```

## Packed-artifact verification

`pack:check` builds every package, creates real `pnpm pack` tarballs in a
test-owned temporary directory, and checks the expanded manifests, Host and
Loader entry points, Cordis patches, declarations, required notices, peer
versions, and dependency closure. It also confirms that Imagegen is
self-contained and has no runtime dependency.

For an explicit release or packaging diagnostic, point the command at an
existing official DSH `0.1.2-rc.1` executable. This selected diagnostic creates
isolated homes, caches, profiles, and loopback ports; it is not part of normal
development or the ordinary handoff loop:

```sh
DSH_CLI=/absolute/path/to/dsh pnpm run artifact:smoke
```

This diagnostic activates the packed artifacts through the real DSH Host/Loader
and uses fakes for provider behavior. It does not send mail or Matrix traffic,
call a paid image provider, use credentials, or mutate the persistent dev
profile. Reuse unchanged results unless a packaging or Host contract changed.

The filtered `@lamplitisles/dsh-nanocodex` packed smoke additionally runs the
actual WASM/QuickJS engine against a test-owned loopback provider that rejects
WebSocket upgrades and completes through HTTP/SSE. It checks DSH tool and
continuation behavior plus the sanitized queryable Host transport diagnostic.

## Independent releases

Each public package is released on its own version. Ask the agent to release a
package, then approve and merge its version PR. The GitHub mirror automatically
publishes packages whose manifest version changed and verifies npm visibility.
The npm version and provenance record the release; no Git tag is needed.
Ordinary code PRs do not publish.

For a new package's first publication, run the interactive bootstrap wizard
from a local commit; no push or merge is required:

```sh
bash scripts/npm-bootstrap.sh @lamplitisles/dsh-tabletop
```

Use `--plan` before the package name to preview the proposed prerelease and
stable version candidate without changes. The wizard changes only a temporary
copy for the confirmed bootstrap publication, then hands stable version
selection back to the version-PR workflow.

For one-time Trusted Publisher setup and failure recovery, see
[`docs/npm-publishing.md`](docs/npm-publishing.md). There is no manual workflow
dispatch or second release approval.

To prepare and inspect a single package locally, select its exact manifest
version using `v<semver>`:

```sh
DSH_CLI=/absolute/path/to/dsh pnpm run release:prepare -- \
  @lamplitisles/dsh-mail v0.1.0 .release-artifacts/dsh-mail
```

The command validates the package metadata, builds/inspects the actual tarball,
runs that package's packed Host gate, and prints the artifact path and npm
dist-tag. Invalid, private, or unknown package selections and malformed tags
fail before an artifact is prepared. Imagegen is selected only through its
public package identity.

No npm credentials, trust configuration, publication, deployment,
or tag cutover is performed by this repository's local release preparation.
Use `og` for Forgejo operations and follow the package's versioning policy.

## Documentation and provenance

Package READMEs describe each plugin's runtime contract and configuration. The
import boundary and pinned source snapshots are recorded in
[`docs/IMPORTS.md`](docs/IMPORTS.md). Contributor and agent workflow guidance
is in [`AGENTS.md`](AGENTS.md).

For persistent development and the separately managed staging profile, follow
[`docs/local-deployment.md`](docs/local-deployment.md). Nanocodex owns the
selected profile's raw Add/Update `apply_patch` tool; DSH remains authoritative
for filesystem policy and ordinary tools.

## License

The workspace is Apache-2.0. Individual packages retain their imported
license and third-party notices; see each package directory.
