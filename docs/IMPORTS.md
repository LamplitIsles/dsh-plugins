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
in this workspace as the DSH adapter for our Nanocodex fork. The reviewed
implementation handoff pins proposed release `v0.5.0-lamplit.2`, built from
source commit `8b37d5fdd650e7b897bb387724cdec0077f4a6f8`. Its verified local
SDK archive has SHA-256
`e07636e6ca2e416d734aa530a14245be2bf81e72b1934c5e3a92bc1fe8c8eb04`, and its
tools archive has SHA-256
`27d984ecc36f00a74e7463a6985019ab2b56f852b202ad7b1cabb5c20d8ce25c`.
The proposed public release URLs remain unpublished; local verification uses
the task-owned archives, and a clean-cache fetch from those URLs is an Owner
publication gate.

[`engine-release.json`](../packages/dsh-nanocodex/engine-release.json) pins the
`nanocodex` `0.5.0` and `nanocodex-tools` `0.1.0` proposed release asset URLs
and SHA-256 checksums. Local installation, CI, and vendor prepack use the
verified task-owned tarballs. The final plugin contains the expanded runtime
and tools; neither building nor installing it requires a sibling engine
checkout. Until the proposed assets are published, the URL pin is provenance
for the reviewed artifact rather than evidence of a remote clean-cache install.

Companion continuity remains owned by the original `dsh-companion` middleware.
The Nanocodex adapter selects that middleware through a non-generating
`purpose: "compaction"` waterfall request, consumes each live
`model.compaction.replaced` outcome once, and maps exact retained item
identities to the DSH surface through the immutable installed-history
provenance contract. It does not carry a duplicate product prompt or create a
second summary runtime. The DSH policy retains at most five complete visible
rounds under a 4,000-token soft budget, preserves the current unfinished turn
and its attachments, and removes historical tool/reasoning/plugin material.
An arbitrary `compactRegion` range is rejected before mutation; successful
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
