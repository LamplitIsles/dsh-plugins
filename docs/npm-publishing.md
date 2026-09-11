# npm publishing

Forgejo owns source changes. Its existing public mirror,
[`LamplitIsles/dsh-plugins`](https://github.com/LamplitIsles/dsh-plugins), runs
`.github/workflows/publish.yml`. Package metadata points to that public source
and includes each package's workspace directory for provenance.

## One-time account setup

After the workflow is merged and appears on GitHub `main`:

1. In GitHub repository Settings → Environments, create `npm`, restrict its
   deployment branches to the branch `main` (not the tag pattern `v*`), with
   no required reviewers. The version PR is the human approval boundary.
2. In each existing npm package's Settings → Trusted publishing, add a GitHub
   Actions connection with these exact values:

   | Field                | Value                       |
   | -------------------- | --------------------------- |
   | Organization or user | `LamplitIsles`              |
   | Repository           | `dsh-plugins`               |
   | Workflow filename    | `publish.yml`               |
   | Environment name     | `npm`                       |
   | Allowed actions      | Enable direct `npm publish` |

3. Existing connections have fixed identity fields: add the new connection
   instead of attempting to edit the old repository identity. Retire old
   repository publishers once their replacement is verified and old releases
   are no longer needed.

New package names need an explicitly confirmed first publication before their
package settings can be configured. Use the bootstrap wizard below; established
packages continue through ordinary version PRs.

Use interactive npm login for manual account operations. No `NPM_TOKEN`,
`NODE_AUTH_TOKEN`, or npm secret is needed by this workflow. GitHub-hosted
runners supply OIDC, and npm generates provenance for the public package.
This is ordinary publishing, not staged publishing: successful `npm publish`
makes the version public immediately.

## Bootstrap a new package

Run the reusable wizard from a locally committed checkout. No push or merge is
required for the bootstrap publication:

```sh
bash scripts/npm-bootstrap.sh --plan @lamplitisles/dsh-tabletop
bash scripts/npm-bootstrap.sh @lamplitisles/dsh-tabletop
```

It accepts a full public package name or its directory from the shared package
inventory. The private workspace root and unknown packages are rejected.
`--plan` prints proposed versions without network access or changes. Interactive
execution requires Node.js `>=24.11.0`, Corepack pnpm 12.3.4, curl, and an existing
official DSH `0.1.2-rc.1` executable on PATH or in `DSH_CLI`.

The wizard exports the local commit into a temporary workspace. For a stable
manifest such as `0.1.0`, it asks before changing **only that temporary copy** to
`0.1.0-beta.0`; an existing prerelease is preserved. Tracked source changes must
be committed locally first. The selected package must be part of that commit.
The original checkout, versions, and Git state remain unchanged.

The temporary workspace obtains Nanocodex from the same pinned GitHub Release
as local development and CI. The root `pnpm:devPreinstall` hook downloads and
SHA-256-verifies the two engine tarballs before dependency resolution. It uses
the public GitHub API with environment proxy support; no GitHub credential or
sibling checkout is required. See
[`engine-release.json`](../packages/dsh-nanocodex/engine-release.json) for the
exact release, asset URLs, and checksums.

It verifies npm login, runs the declared frozen install, workspace checks,
packing, real DSH artifact smoke, registry preflight, and selected-package
release preparation in the temporary workspace. It then asks before publishing
the verified tarball publicly under `beta`. Only the selected package is
published. Registry errors stop execution; an exact version that already exists
skips completed validation/publication. A successful publish is followed by
propagation checks. Temporary builds and tarballs are removed on exit.
No token is captured, `.env` is untouched, and no CI secret is created.

After bootstrap, the wizard checks the public GitHub workflow with curl, which
uses the environment proxy, and guides the human through the `npm` environment
and package's Trusted Publisher settings. This verifies existing release
infrastructure; it does not wait for the new package to be merged. If this
lookup fails after publication, rerunning resumes setup without republishing.

The stable release is a separate version PR. The agent must inspect both main
and npm before selecting its version: a newly added manifest does not publish,
and an unchanged version cannot trigger the workflow. If main already records
`0.1.0`, choose a higher unpublished stable version for that PR. If main has a
prerelease baseline, changing it to `0.1.0` can trigger that stable release.
The wizard does not change stable versions, commit, push, merge, tag, or deploy.

## Release a package

Ask the agent to release a package, then approve and merge its version PR.
Everything after that is automatic: Forgejo mirrors `main` to GitHub, the
workflow publishes the changed package and verifies npm visibility.
The npm version and provenance record the release and its source commit.
There is no manual workflow dispatch, release tag to push, or second approval.

The agent checks npm versions and dist-tags before proposing the version.
Current imported versions are not release recommendations; several are below
their existing npm latest. Wait for the package's release to finish before
merging its next version PR.

The workflow compares package manifest versions across the complete mirrored
push (`before` to the exact pushed commit). Ordinary code or metadata changes
without a version change do not publish. If multiple packages change version,
each gets an independent job; other packages are left alone. A newly added
manifest is not a release request, and a missing baseline or non-fast-forward
push fails closed. Batched version bumps of the same package publish only the
final version in that push.

Each release checks metadata and npm availability, runs workspace
typechecks/tests and eight-package packing, installs an isolated DSH rc.1
runtime, and runs the selected packed Host gate before publishing its tarball
using OIDC. Stable versions use `latest`; prereleases use `beta`. Existing
versions and stable versions at or below npm `latest` are rejected.

No Git tags are created: Forgejo's push mirror would remove tags created only
on GitHub. The workflow never changes manifest versions or deploys the local
web profile, and needs no repository write permission or Forgejo credentials.

## Failed releases

Ask the agent to inspect the failed job. If nothing reached npm and the cause
was transient infrastructure or account configuration, correct it and retry the
failed job. A rerun uses the original source commit: a source-code fix needs a
new version change in its PR to trigger publication of the fixed commit.
An unpublished failed version may be skipped. Do not rerun successful package jobs.
If npm accepted the version but registry verification timed out, check the
exact published version and provenance before considering recovery. Do not
republish it: the preflight deliberately rejects already published versions.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
