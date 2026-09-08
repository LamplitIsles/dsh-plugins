# Codex code mode

This context describes how an Agent uses raw programs and patches through the Codex provider route.

## Language

**Direct tool surface**:
The two top-level tools offered on the selected route: `run_code` followed by
raw `apply_patch`. A tool's presence in the SDK does not make it part of the
direct tool surface. The route requires DSH tools presentation `both`.
_Avoid_: all available tools

**SDK tool catalog**:
The other DSH tools an Agent can invoke from a code-mode program. It retains
reads, shell, and other permitted capabilities, but omits and denies the
ordinary `edit` and `write` tools on this route.

**Code-mode program**:
A raw TypeScript function body submitted to `run_code`, with access to the Agent's SDK tool catalog.

**Patch edit**:
A file change expressed as a Codex patch containing file operations and contextual changes. Removing lines from an existing file is distinct from deleting the file.

**Supported patch subset**:
The Codex envelope, Add File, Update File, contextual `@@` hunks, line
additions/removals, and optional end-of-file anchoring. Delete File, Move to,
binary targets, and unmatched or ambiguous hunks are rejected. Compatibility
with this subset does not promise every Codex operation or identical failure
behavior.

**Patch preflight**:
The complete parse, path resolution, observation check, target read, hunk
match, and resulting-content calculation that happens before the first write.
It checks existing observations without creating a new one, so preflight
failure is mutation-free. Publication then uses DSH write-intent and
version-guarded atomic writes in patch order, recording each committed version
only after its write succeeds.

**Patch processing bounds**:
`maxPatchChars` defaults to 4,000,000, `maxPatchFiles` to 64, and
`maxPatchFileBytes` to 4,000,000. Each is a validated positive safe integer
setting and can be changed live with the route.

**Patch outcome**:
The structured result with an overall `applied`, `partial`, `failed`, or
`cancelled` status, per-file committed/failed/unattempted statuses, and diffs
for files that actually committed. Later failures do not roll back earlier
files or trigger an automatic retry.
