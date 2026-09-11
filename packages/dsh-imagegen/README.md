# Kepos Image Generation for DSH

Install it in a DSH profile:

```sh
dsh plugin --profile <profile> add @lamplitisles/dsh-imagegen
```

This package targets the DSH `0.1.2-rc.1` API contract.

Open DSH Settings and use **Kepos Image Generation** to set the bridge address and
the two model identifiers. **Generation model** defaults to
`gpt-image-2.5-flare`; **Editing model** defaults to `gpt-image-2.5-sunburst`.
The Host uses the generation model when `images` is omitted and the editing model
when one through five PNG, JPEG, GIF, or WebP files are supplied. Model values
must be nonblank; surrounding whitespace is trimmed before saving and sending the
request. Kepos owns authentication; this plugin does not accept or store
credentials.

The bridge must accept the explicit `model` field on `POST /codex/images` and
forward it to its image provider. Deploy the matching bridge and imagegen
changes together; this plugin has no bridge-side model default or compatibility
fallback. The model policy is changed in the DSH settings card rather than in
the bridge.

## Image naming

Every generation or edit call requires an agent-selected `filename` and a
nonblank English `prompt`. Filename language is independent of the prompt, so
the agent may use English or Chinese, including spaces:

```json
{
  "prompt": "A watercolor painting of a beach at dusk with warm sunset light.",
  "filename": "海边日落.png"
}
```

The filename is one name, not a directory or arbitrary path. Surrounding
whitespace is trimmed, `.png` is appended when omitted, and a case-insensitive
`.PNG` suffix is normalized to `.png`. Other extensions, path separators,
traversal names, control characters, and names unsuitable for cross-platform
downloads are rejected in English before the provider is called.

Every generated image is saved under `.dsh/kepos-imagegen/` in the active
workspace. Existing files are never overwritten: the first available name is
`海边日落.png`, followed by `海边日落-1.png`, then `海边日落-2.png`, and so on.
Numeric suffixes already present in the requested name are not parsed. The
returned relative path is the actual saved path and can be used in a later
image-edit call; the attachment and its PNG download use that same saved
filename.

## Development and packed verification

Run the package from the workspace root with Node.js `>=24.11.0` and pnpm 12.3.4:

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
generated model-bearing request, PNG write, and attachment result. Imagegen's
provider and workspace-boundary core is implemented as ordinary internal modules
in the artifact; no second workspace package is installed at runtime,
and the smoke never calls a paid image provider or touches a live workspace.
The packed gate is not the host-local rendered-client acceptance check: that
task-scoped check still requires an authorized deployment/restart of the host
instance and is not performed by this package workflow.

## Independent release

Prepare only this public package and an exact matching tag from the workspace
root:

```sh
DSH_CLI=/absolute/path/to/dsh corepack pnpm run release:prepare -- \
  @lamplitisles/dsh-imagegen v0.1.0 .release-artifacts/dsh-imagegen
```

Review the verified tarball, then publish it separately with existing npm
credentials at the registry boundary. Imagegen's core is an internal module
and is included directly in this package; there is no second package to select
or publish.
