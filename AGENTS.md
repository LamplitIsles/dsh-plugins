# Contributor and agent guidance

## Workspace ownership

- Treat the root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` as
  the workspace source of truth. Use Node.js 24 and pnpm 11.22.0 through
  Corepack; keep dependency ownership in the package that imports it.
- The six public packages under `packages/` keep independent names and
  versions. Imagegen's core is an internal module in `packages/dsh-imagegen`;
  there is no separate private workspace package.
- Keep the DSH/Cordis/Schemastery/React contract versions aligned with the root
  catalog. Host-provided DSH modules remain peer dependencies and external
  build inputs.

## Change and verification loop

Make an end-to-end change that leaves the main path usable, then run the
smallest relevant filtered check. Before handoff, run the complete workspace
commands from the root README:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run pack:check
```

For packaging or Host changes, also run the real packed gate with an existing
official DSH `0.1.2-rc.1` executable:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run artifact:smoke
```

Smoke checks own their temporary homes, caches, profiles, and ports. Provider
calls, credentials, live DSH profiles, user workspaces, mailboxes, Matrix
rooms, and paid image generation remain outside tests.

The one-off local identity migration is described in
[`docs/identity-migration.md`](docs/identity-migration.md). Its plan/check and
fixture tests never mutate `/home/neil/.local/state/dsh`; only the Owner runs
the documented build, service-stop, restricted-backup, DSH `link:`
reconciliation, restart, and cold-client verification sequence after review
and merge.

## Artifacts and releases

Use `corepack pnpm run pack:check` or the package's filtered `pack-smoke` to
inspect actual `pnpm pack` output. A release selects exactly one public package
and an exact `v<semver>` tag:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-mail v0.1.0 .release-artifacts/dsh-mail
```

Review the produced tarball before the separate, operator-driven `npm publish`
registry action. Release preparation does not publish, deploy, create trust
configuration, or modify credentials. Use `og` for Forgejo clone/pull/push,
authentication, tags, comments, and CI operations.

## Repository boundaries

Preserve the imported product behavior and optional cross-plugin contracts.
Do not add compatibility layers for retired workflows, broaden Host peers into
runtime dependencies, or couple unrelated package versions. Keep source
provenance in `docs/IMPORTS.md`; keep temporary plans and deferred ideas under
`.scratch/` without adding them to Git. Do not edit the sibling source
repositories as part of this workspace task.
