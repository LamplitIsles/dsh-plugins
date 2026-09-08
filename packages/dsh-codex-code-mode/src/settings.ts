import { isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SETTINGS,
  type CodexModelSettings,
  type CodexSettings,
} from "./constants.js";

const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
});

export const CodexSettingsSchema: z<CodexSettings> = z.object({
  enabled: z.boolean().default(DEFAULT_SETTINGS.enabled),
  baseURL: z.string().default(DEFAULT_SETTINGS.baseURL),
  credentialRef: z
    .string()
    .role("credential-ref")
    .default(DEFAULT_SETTINGS.credentialRef),
  models: z.array(modelSchema).default([]),
  transport: z
    .union(["auto", "sse", "websocket", "websocket-cached"])
    .default(DEFAULT_SETTINGS.transport),
});

export function validateCodexSettings(settings: CodexSettings): void {
  if (!settings.enabled) return;
  let endpoint: URL;
  try {
    endpoint = new URL(settings.baseURL);
  } catch {
    throw new TypeError(
      `${"dsh-codex-code-mode"}: enabled configuration requires a valid baseURL`,
    );
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError(
      "dsh-codex-code-mode: baseURL must use http or https when enabled",
    );
  }
  if (!isCredentialRefName(settings.credentialRef)) {
    throw new TypeError(
      "dsh-codex-code-mode: enabled configuration requires credentialRef to be a POSIX credential reference",
    );
  }
  if (settings.models.length === 0) {
    throw new TypeError(
      "dsh-codex-code-mode: enabled configuration requires at least one model",
    );
  }
  const ids = new Set<string>();
  for (const model of settings.models) {
    if (model.id.trim().length === 0) {
      throw new TypeError("dsh-codex-code-mode: model ids must be non-empty");
    }
    if (ids.has(model.id)) {
      throw new TypeError(
        `dsh-codex-code-mode: duplicate model id ${JSON.stringify(model.id)}`,
      );
    }
    ids.add(model.id);
  }
}

export function normalizeCodexModel(
  model: CodexModelSettings,
): CodexModelSettings {
  return {
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export type { CodexModelSettings, CodexSettings } from "./constants.js";
