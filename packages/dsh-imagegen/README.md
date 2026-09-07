# Kepos Image Generation for DSH

Install it in a DSH profile:

```sh
dsh plugin --profile <profile> add @lamplitisles/dsh-imagegen
```

This package targets the DSH `0.1.2-rc.1` API contract.

Open DSH Settings and use **Kepos Image Generation** to set the bridge address. The
tool generates when `images` is omitted and edits one through five PNG, JPEG, GIF,
or WebP files named relative to the active workspace. Kepos owns authentication;
this plugin does not accept or store credentials.

Every generated image is saved under `.dsh/kepos-imagegen/` in the active
workspace. The returned relative path can be used in a later image-edit call;
the DSH tool card also provides a preview and PNG download.

## Development and packed verification

Run the package from the workspace root with Node.js 24 and pnpm 11.22.0:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @lamplitisles/dsh-imagegen run typecheck
corepack pnpm --filter @lamplitisles/dsh-imagegen run test
corepack pnpm --filter @lamplitisles/dsh-imagegen run build
DSH_CLI=/absolute/path/to/dsh corepack pnpm --filter @lamplitisles/dsh-imagegen run pack-smoke
```

The packed smoke installs the DSH-only artifact into a disposable real
`0.1.2-rc.1` Web profile, loads its served client through the Web bootstrap's
module Loader, and verifies the Host Settings namespace. A separate real
Cordis Loader run activates the packed Host entry and calls
`kepos_image_generate` through a test-owned HTTP fake bridge, checking the
generated PNG write and attachment result. Imagegen's private core is bundled
into the artifact; no private workspace dependency is installed at runtime,
and the smoke never calls a paid image provider or touches a live workspace.

## Independent release

Prepare only this public package and an exact matching tag from the workspace
root:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-imagegen v0.1.0 .release-artifacts/dsh-imagegen
```

Review the verified tarball, then publish it separately with existing npm
credentials at the registry boundary. The private `imagegen-core` package is
never selected or published.
