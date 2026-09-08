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

   | Field | Value |
   |---|---|
   | Organization or user | `LamplitIsles` |
   | Repository | `dsh-plugins` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |
   | Allowed actions | Enable direct `npm publish` |

3. Existing connections have fixed identity fields: add the new connection
   instead of attempting to edit the old repository identity. Retire old
   repository publishers once their replacement is verified and old releases
   are no longer needed.

Speech and Hindsight's new package names need an explicitly approved first
publication before their package settings can be configured. Bootstrap and
version changes are separate from this workflow setup. The other four package
names already have published versions; preserve their version histories.

Use interactive npm login for manual account operations. No `NPM_TOKEN`,
`NODE_AUTH_TOKEN`, or npm secret is needed by this workflow. GitHub-hosted
runners supply OIDC, and npm generates provenance for the public package.
This is ordinary publishing, not staged publishing: successful `npm publish`
makes the version public immediately.

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
typechecks/tests and six-package packing, installs an isolated DSH rc.1
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
