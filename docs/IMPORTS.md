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

`packages/dsh-codex-code-mode` (`@lamplitisles/dsh-codex-code-mode`) was also
authored directly in this workspace. Its provider seam is a minimal wrapper
around the published `@earendil-works/pi-ai@0.84.4` Codex Responses API and
the DSH `0.1.2-rc.1` Host contracts; no external source snapshot was copied.
