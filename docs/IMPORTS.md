# Import provenance

The initial workspace import delivered six public DSH plugins. Product
files, tests, required assets, license notices, and relevant documentation were
copied from the pinned source snapshots below. The source checkouts were read
only; their histories, remotes, services, credentials, and installed files were
not changed.

| Workspace package                                              | Source snapshot                                                 | Delivered identity            |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------- |
| `packages/dsh-companion`                                       | `dsh-companion` at `4cdbecb0e975d3136554fd3b8bc1e8c70a48f1d0`   | `@lamplitisles/dsh-companion` |
| `packages/dsh-mail`                                            | `dsh-mail` at `2acd4948ec405129d9273e6bb030dff8b0511285`        | `@lamplitisles/dsh-mail`      |
| `packages/dsh-matrix`                                          | `dsh-matrix` at `02e98f757f4352a34726a5d42e9aac240ee16270`      | `@lamplitisles/dsh-matrix`    |
| `packages/dsh-speech` (renamed from the imported directory)    | `kepos-speech` at `06f596067289eb0ffea0bab1f5fa399a11a32d34`    | `@lamplitisles/dsh-speech`    |
| `packages/dsh-hindsight` (renamed from the imported directory) | `kepos-hindsight` at `06e8ed39eb7725da2ebf514e2e6b883249c66e40` | `@lamplitisles/dsh-hindsight` |
| `packages/dsh-imagegen` (core inlined into this package)       | `kepos-imagegen` at `f1fc9f85a6969df5b6796e1df411f8ebfa1f3e2a`  | `@lamplitisles/dsh-imagegen`  |

The mechanical import was committed as `b2b78d732591bde1ad162a02b71b970066913785`.
The target repository's initial fixed point was
`c06f14d01e8daf5f4454a53796aef3466f3c644a`. Adaptation commits after the
import contain only workspace/runtime, DSH rc.1 contract, packaging/release,
and documentation changes required by this repository.

The import intentionally omits generated output, dependency trees, superseded
package-manager lockfiles, standalone CI wiring, scratch material, and source
repository instructions that assume separate checkouts. The DSH adapter and
private core are retained for Imagegen; its separate Pi adapter is not part of
this delivery. Keet and unrelated bridge, infrastructure, and TTS projects are
outside this workspace.

Each public package retains its own npm name and version. The root pnpm lockfile
is the only workspace lockfile. Forgejo remains the source of truth; package
metadata points to its public GitHub mirror for npm provenance:

`https://github.com/LamplitIsles/dsh-plugins.git`

`packages/dsh-tabletop` (`@lamplitisles/dsh-tabletop`) was authored directly in
this workspace; it has no imported source snapshot.

`packages/dsh-nanocodex` (`@lamplitisles/dsh-nanocodex`) was authored directly
in this workspace as the DSH adapter for our Nanocodex fork. It consumes
[GitHub Release `v0.5.0-lamplit.1`](https://github.com/LamplitIsles/nanocodex/releases/tag/v0.5.0-lamplit.1),
whose source commit is `f598d5714d9ed1ab25b53d32c6047dd10171cb88`.
The accepted build revision `32f5f6e4031040f4b7fac7aefd2a64d7d4baedf2`
and the squash-merged source commit have the same Git tree. The SDK's
publication refreshes only its build provenance record; executable code,
types, and WASM are unchanged from the accepted artifact.

[`engine-release.json`](../packages/dsh-nanocodex/engine-release.json) pins the
`nanocodex` `0.5.0` and `nanocodex-tools` `0.1.0` release asset URLs and SHA-256
checksums. Local installation, CI, and vendor prepack use those same verified
tarballs. The final plugin contains the expanded runtime and tools; neither
building nor installing it requires a sibling engine checkout.

Companion continuity remains owned by the original `dsh-companion` middleware.
The Nanocodex adapter selects that middleware through a non-generating
`purpose: "compaction"` waterfall request, consumes each live
`model.compaction.replaced` outcome once, and maps exact retained item
identities to the DSH prefix before the latest real user-led tail. It does not
carry a duplicate product prompt or create a second summary runtime. An
arbitrary `compactRegion` middle range is rejected before mutation; successful
manual and automatic replacements use the warm runtime and the standard DSH
private checkpoint projection.

The retired Codex code-mode package was authored directly in this workspace and
is no longer a supported or shipped package. Its direct patch parser and
matcher now live in `packages/dsh-nanocodex` as the one maintained DSH-owned
editor. They remain narrow Apache-2.0 ports of the OpenAI Codex `apply-patch`
implementation at commit `8e6a44b428e31f91b21edc97904fcdf4f0931ade`; the
supported operation set removes Codex delete and move operations. Nanocodex
carries the attribution and license references in `NOTICE` and
`THIRD_PARTY_NOTICES.md`. The retired provider, PTC wrapper, settings and
transport were not moved.
