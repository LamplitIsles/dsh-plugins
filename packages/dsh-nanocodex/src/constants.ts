export const PLUGIN_NAME = "dsh-nanocodex" as const;

export const APPLY_PATCH_NAME = "apply_patch" as const;
export const APPLY_PATCH_DESCRIPTION =
  "Apply a raw Codex patch to text files in the active workspace. Call apply_patch(input: string) with a complete Add File/Update File patch. Supports Add File and Update File with contextual hunks; Delete File and Move to are not supported." as const;
export const APPLY_PATCH_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
update_hunk: "*** Update File: " filename LF change+
filename: /(.+)/
add_line: "+" /(.*)/ LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;

export const DEFAULT_MAX_PATCH_CHARS = 4_000_000;
export const DEFAULT_MAX_PATCH_FILES = 64;
export const DEFAULT_MAX_PATCH_FILE_BYTES = 4_000_000;

export const SUPPORTED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
] as const;

export type NanocodexModel = (typeof SUPPORTED_MODELS)[number];

export function isSupportedModel(
  value: string | undefined,
): value is NanocodexModel {
  return (
    value !== undefined &&
    (SUPPORTED_MODELS as readonly string[]).includes(value)
  );
}

export function isSupportedRoute(
  provider: string | undefined,
  api: string | undefined,
): boolean {
  return (
    (provider === "openai" || provider === "openai-codex-responses") &&
    (api === "openai-responses" || api === "openai")
  );
}
