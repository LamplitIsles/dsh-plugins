# npm publishing

Forgejo owns source changes. Its existing public mirror,
[`LamplitIsles/dsh-plugins`](https://github.com/LamplitIsles/dsh-plugins), runs
`.github/workflows/publish.yml`. Package metadata points to that public source
and includes each package's workspace directory for provenance.

## One-time account setup

After the workflow is merged and appears on GitHub `main`:

1. In GitHub repository Settings → Environments, create `npm`, restrict its
   deployment branches to `main`, and configure required reviewer approval.
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

## Release one package

1. Inspect the package's npm versions and dist-tags. Commit the intended new
   version through a Forgejo PR; do not reuse an existing published version.
2. Merge and wait until GitHub `main` has the same source commit and workflow.
   Mirroring commits does not itself publish; no tag forwarding is required.
3. In GitHub Actions → Publish npm package → Run workflow, select `main`, one
   package, and its exact committed version without a `v` prefix.
4. Approve the `npm` environment deployment. The job checks metadata and npm
   availability, runs workspace typechecks/tests and six-package packing,
   installs an isolated DSH rc.1 runtime, and runs the selected packed Host
   gate before publishing its tarball. Stable versions use `latest`;
   prereleases use `beta`. Stable versions at or below npm `latest` are rejected.
5. Confirm registry verification succeeds. If publication succeeds but a later
   check fails, inspect the exact npm version before retrying: published
   versions cannot be overwritten.

The workflow never changes manifest versions, creates release tags, deploys
the local web profile, or publishes other packages. Current imported versions
are not release recommendations; several are below their existing npm latest.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
