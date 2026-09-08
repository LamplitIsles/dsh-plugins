export const PLUGIN_NAME = "dsh-codex-code-mode" as const;
export const PROVIDER_ID = "codex-code-mode" as const;
export const SETTINGS_NAMESPACE = PLUGIN_NAME;
export const RUN_CODE_NAME = "run_code" as const;
export const RUN_CODE_DESCRIPTION = "Run code" as const;
export const CODE_MODE_TOOL_DESCRIPTION =
  "Execute raw TypeScript/JavaScript as an async DSH function body. Use top-level await and return the curated result; call available tools as tools.<name>(args), awaiting calls individually or with Promise.all as needed." as const;

/**
 * The grammar constrains the wire value to one non-empty raw source string.
 * JavaScript/TypeScript validity and safety remain DSH's PTC/runtime concern.
 */
export const CODE_MODE_GRAMMAR = String.raw`start: source
source: /[\s\S]+/`;

export const DEFAULT_CONTEXT_WINDOW = 262_144;
export const DEFAULT_MAX_TOKENS = 32_768;

export const DEFAULT_SETTINGS = {
  enabled: false,
  baseURL: "",
  credentialRef: "",
  models: [],
  transport: "auto",
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
}
