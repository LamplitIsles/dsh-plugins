# Contributor and agent guidance

## Workspace ownership

- Treat the root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` as
  the workspace source of truth. Use Node.js `>=24.11.0` and pnpm 12.3.4 through
  Corepack; keep dependency ownership in the package that imports it. One-time
  host setup is `corepack enable pnpm`; thereafter use the plain `pnpm` command
  and verify `pnpm --version` resolves to the root `packageManager` pin.
- The eight public packages under `packages/` keep independent names and
  versions. Imagegen's core is an internal module in `packages/dsh-imagegen`;
  there is no separate private workspace package.
- Keep the DSH/Cordis/Schemastery/React contract versions aligned with the root
  catalog. Host-provided DSH modules remain peer dependencies and external
  build inputs.

## Change and verification loop

Make an end-to-end change that leaves the main path usable, then run the
smallest relevant filtered check. For Host or rendered-client changes, the
normal development acceptance target is the already-provisioned persistent
`dsh-dev.service` environment:

```sh
pnpm run dev:deploy -- @lamplitisles/dsh-nanocodex
```

Replace the package selector with the affected public package(s). The command
builds and packs only the selected artifacts, updates only matching plugins
already present in the persistent `web` profile, and restarts only
`dsh-dev.service`. It reuses the installed DSH executable, DSH home, profile,
settings, credentials, and sessions; it never provisions a runtime or a fresh
DSH environment. The script is bound to the documented executable, home,
runtime, `web` profile, and service; inconsistent `DSH_CLI`, `DSH_HOME`, or
`DSH_RUNTIME` overrides fail before build or service mutation, and the install
child receives the exact dev `DSH_HOME`. Follow it with task-scoped browser
acceptance when the change affects the client. Before handoff, run the complete
workspace commands from the root README:

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:check
```

`lint:fix` and `format` are local, explicitly requested write operations; CI
and handoff checks use only `lint` and `format:check`. Oxlint covers authored
JavaScript/TypeScript/TSX with the configured Svelte environment and Oxfmt also
formats Svelte, CSS Modules, config, and docs. These static gates do not
replace rendered-client acceptance on the persistent dev Host.

`artifact:smoke` is an explicit release and packaging diagnostic, not a normal
development or handoff prerequisite. Run it only when the packed Host/Loader
contract needs fresh evidence, using an existing official DSH `0.1.2-rc.1`
executable:

```sh
DSH_CLI=/absolute/path/to/dsh pnpm run artifact:smoke
```

The selected packed smoke owns its temporary homes, caches, profiles, and
ports. Provider calls, credentials, the persistent development profile, user
workspaces, mailboxes, Matrix rooms, and paid image generation remain outside
tests. Ordinary tests never target the persistent dev state.

For the persistent development workflow and the separate staging procedure,
follow [`docs/local-deployment.md`](docs/local-deployment.md). HTTP readiness
from `dev:deploy` is only a service check; client behavior still needs the
task-scoped browser acceptance described below.

### Rendered-client acceptance

For plugin UI, CSS injection, or client Loader changes, use the persistent
host-local development DSH with the `agent-browser` skill to inspect the actual
served client. Deployment and service restarts still require explicit user
authorization; if the running instance does not contain the changes, use
`dev:deploy` after authorization. Do not create a disposable DSH/browser
environment for ordinary acceptance.
Check a representative affected surface, including expanded/collapsed states
and applied styles where relevant, and record the observed result. Keep this
as task-scoped browser acceptance, separate from isolated automated tests;
do not change settings, credentials, or provider data without authorization.

Do not add or extend Playwright suites, disposable browser environments, or
permanent browser-test infrastructure for this acceptance path. Existing
Companion fixture tests remain available for changes to that fixture; they
are not a substitute for the host-local check. Reuse completed checks for
unchanged code, and rerun heavy artifact gates only when later changes affect
the packaging, Host, or client-loading contracts they verify.

## Artifacts and releases

Use `pnpm run pack:check` or the package's filtered `pack-smoke` to
inspect actual `pnpm pack` output. Local `release:prepare` selects exactly one
public package and its exact manifest version as a `v<semver>` argument:

```sh
DSH_CLI=/absolute/path/to/dsh pnpm run release:prepare -- \
  @lamplitisles/dsh-mail v0.1.0 .release-artifacts/dsh-mail
```

For requested releases, check npm versions/dist-tags and open a PR updating the
selected packages' versions and any required release changes. Merging that PR
publishes each changed package independently through the GitHub mirror, without
Git tags. One PR may update one or more packages; follow
[`docs/npm-publishing.md`](docs/npm-publishing.md) for setup and recovery.
For a new package, use `scripts/npm-bootstrap.sh <package>` from a local commit;
see the bootstrap section in `docs/npm-publishing.md`. It confirms the version
change only in a temporary copy and local prerelease publication, with no
pre-merge wait or checkout mutation. Select the later stable version PR against
both main and npm; adding a manifest or leaving its version unchanged does not
trigger CI publication.

Local release preparation does not publish, deploy, create trust
configuration, or modify credentials. Use `og` for Forgejo clone/pull/push,
authentication, tags, comments, and CI operations.

## Repository boundaries

Preserve the imported product behavior and optional cross-plugin contracts.
Do not add compatibility layers for retired workflows, broaden Host peers into
runtime dependencies, or couple unrelated package versions. Keep source
provenance in `docs/IMPORTS.md`; keep temporary plans and deferred ideas under
`.scratch/` without adding them to Git.
