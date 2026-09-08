export const PLUGIN_NAME = "dsh-codex-code-mode" as const;
export const PROVIDER_ID = "codex-code-mode" as const;
export const SETTINGS_NAMESPACE = PLUGIN_NAME;
export const RUN_CODE_NAME = "run_code" as const;
export const RUN_CODE_DESCRIPTION = "Run code" as const;
export const APPLY_PATCH_NAME = "apply_patch" as const;
export const APPLY_PATCH_DESCRIPTION =
  "Apply a raw Codex patch to text files in the active workspace. Supports Add File and Update File with contextual hunks; Delete File and Move to are not supported." as const;
export const CODE_MODE_TOOL_DESCRIPTION =
  "Execute raw TypeScript/JavaScript as an async DSH function body. Use top-level await and return the curated result; call available tools as tools.<name>(args), awaiting calls individually or with Promise.all as needed." as const;

/**
 * The grammar constrains the wire value to one non-empty raw source string.
 * JavaScript/TypeScript validity and safety remain DSH's PTC/runtime concern.
 */
export const CODE_MODE_GRAMMAR = String.raw`start: source
source: /[\s\S]+/`;

/** The wire grammar advertises only the supported raw Codex patch subset. */
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

export const DEFAULT_CONTEXT_WINDOW = 262_144;
export const DEFAULT_MAX_TOKENS = 32_768;
export const DEFAULT_MAX_PATCH_CHARS = 4_000_000;
export const DEFAULT_MAX_PATCH_FILES = 64;
export const DEFAULT_MAX_PATCH_FILE_BYTES = 4_000_000;

export const DEFAULT_SETTINGS = {
  enabled: false,
  baseURL: "",
  credentialRef: "",
  models: [],
  transport: "auto",
  maxPatchChars: DEFAULT_MAX_PATCH_CHARS,
  maxPatchFiles: DEFAULT_MAX_PATCH_FILES,
  maxPatchFileBytes: DEFAULT_MAX_PATCH_FILE_BYTES,
} as const;

export type CodexTransport = "auto" | "sse" | "websocket" | "websocket-cached";

export interface CodexModelSettings {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export interface CodexSettings {
  enabled: boolean;
  baseURL: string;
  credentialRef: string;
  models: CodexModelSettings[];
  transport: CodexTransport;
  maxPatchChars: number;
  maxPatchFiles: number;
  maxPatchFileBytes: number;
}
