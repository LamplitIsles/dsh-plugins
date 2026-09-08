# dsh-plugins

**Seven independently installable DeepSeek Harness plugins—companion UI, email, Matrix, speech, memory, image generation, and dice rolling—in one pnpm workspace.**

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck && corepack pnpm run test && corepack pnpm run build
```

The workspace targets Node.js 24, pnpm 11.22.0, and the DSH `0.1.2-rc.1`
contract family (Cordis `4.0.2`, Schemastery `3.18.2`). The public package
identities and versions remain independent.

## Packages

| Package | Purpose |
|---|---|
| `@lamplitisles/dsh-companion` | A focused Svelte chat surface at `/companion/`, with durable session and relationship behavior. |
| `@lamplitisles/dsh-mail` | A single Settings-owned Agent mailbox with six purpose-built mail tools and loopback OAuth. |
| `@lamplitisles/dsh-matrix` | Matrix room reading, search, and explicit message delivery through DSH tools. |
| `@lamplitisles/dsh-speech` | Tagged TTS playback and optional Qwen ASR through an isolated Host service. |
| `@lamplitisles/dsh-hindsight` | Companion-oriented Hindsight recall, retention, and deliberate reflection. |
| `@lamplitisles/dsh-imagegen` | DSH image generation and editing under the active workspace. |
| `@lamplitisles/dsh-tabletop` | Host-only `roll_dice` with structured inputs and unbiased dice rolls. |

Imagegen keeps its provider and workspace-boundary core as ordinary internal
modules in the public package; there is no separate private workspace package.

## Workspace commands

Install once from the repository root:

```sh
corepack pnpm install --frozen-lockfile
```

Run the complete local checks:

```sh
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run pack:check
```

Run one package from the same workspace:

```sh
corepack pnpm --filter @lamplitisles/dsh-mail run test
corepack pnpm --filter @lamplitisles/dsh-mail run build
```

The Companion browser suite is opt-in because it needs Playwright's browser
installation:

```sh
corepack pnpm run test:e2e
```

## Packed-artifact verification

`pack:check` builds every package, creates real `pnpm pack` tarballs in a
test-owned temporary directory, and checks the expanded manifests, Host and
Loader entry points, Cordis patches, declarations, required notices, peer
versions, and dependency closure. It also confirms that Imagegen is
self-contained and has no runtime dependency.

For the full installed-Host gate, point the command at an existing official
DSH `0.1.2-rc.1` executable. The check creates isolated homes, caches, profiles,
and loopback ports and removes them when it finishes:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run artifact:smoke
```

This gate activates all seven packed artifacts through the real DSH Host/Loader
and uses fakes for provider behavior. It does not send mail or Matrix traffic,
call a paid image provider, use credentials, or mutate a live profile.

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
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
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

For an explicitly requested host-local update, follow the seven-package
build, link, restart, and verification procedure in
[`docs/local-deployment.md`](docs/local-deployment.md).

## License

The workspace is Apache-2.0. Individual packages retain their imported
license and third-party notices; see each package directory.
