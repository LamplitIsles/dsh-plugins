import {
  credentialRef,
  type CredentialRef,
} from "@deepseek-ai/dsh-credentials";
import type { AgentOptions } from "@deepseek-ai/dsh-agent";
import z from "@deepseek-ai/schemastery";
import {
  isSupportedModel,
  isSupportedRoute,
  type NanocodexModel,
} from "./constants.js";

export const SETTINGS_NAMESPACE = "llm-pi-ai" as const;

export const SUPPORTED_PROVIDERS = [
  "openai",
  "openai-codex-responses",
] as const;

export type NanocodexProvider = (typeof SUPPORTED_PROVIDERS)[number];

const DEFAULT_NATIVE_API = "openai-responses";

/** The small part of the retired pi-ai profile that the adapter consumes. */
export interface NanocodexProviderProfile {
  readonly apiKeyEnv?: string;
  readonly api?: string;
  readonly baseURL?: string;
  readonly websocketURL?: string;
  readonly reasoning?: string;
}

export interface NanocodexSettings {
  readonly providers: Record<string, NanocodexProviderProfile>;
}

const profile = z
  .object({
    apiKeyEnv: z.string(),
    api: z.string(),
    baseURL: z.string(),
    websocketURL: z.string(),
    reasoning: z.string(),
  })
  .loose(true);

/**
 * Keep the existing settings namespace and profile shape readable by DSH
 * configuration surfaces while accepting fields owned by older pi-ai
 * profiles. Nanocodex intentionally validates only the route fields it can
 * act on at request admission.
 */
export const NanocodexSettingsSchema: z<NanocodexSettings> = z.object({
  providers: z.dict(profile).default({}),
});

function normalizedApi(
  provider: string,
  api: string | undefined,
): string | undefined {
  if (api !== undefined) return api;
  return SUPPORTED_PROVIDERS.includes(provider as NanocodexProvider)
    ? DEFAULT_NATIVE_API
    : undefined;
}

export function configuredNanocodexProviders(
  value: NanocodexSettings,
): NanocodexProvider[] {
  return SUPPORTED_PROVIDERS.filter((provider) => {
    const configured = value.providers[provider];
    return (
      configured !== undefined &&
      isSupportedRoute(provider, normalizedApi(provider, configured.api))
    );
  });
}

export interface ResolvedNanocodexRoute {
  readonly provider: string;
  readonly model: NanocodexModel;
  readonly apiKey: string;
  readonly apiBaseUrl?: string;
  readonly websocketUrl?: string;
  readonly thinking?:
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | undefined;
}

export interface SettingsContext {
  readonly settings: {
    get(namespace: string): unknown;
  };
  readonly credentials: {
    resolve(ref: CredentialRef): Promise<{ value: string } | undefined>;
  };
}

function settingsValue(ctx: SettingsContext): NanocodexSettings {
  const value = ctx.settings.get(SETTINGS_NAMESPACE);
  if (!value || typeof value !== "object") {
    throw new Error(
      `Nanocodex route settings are unavailable: register ${SETTINGS_NAMESPACE} before creating an agent`,
    );
  }
  const providers = (value as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error(
      `Nanocodex route settings ${SETTINGS_NAMESPACE}.providers is invalid`,
    );
  }
  return { providers: providers as Record<string, NanocodexProviderProfile> };
}

function thinking(
  value: string | undefined,
): ResolvedNanocodexRoute["thinking"] {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return undefined;
}

export function supportedThinking(
  value: string | undefined,
): "none" | "low" | "medium" | "high" | "xhigh" | "max" | "pro" | undefined {
  if (value === "pro") return value;
  return thinking(value);
}

/** Resolve one explicit DSH route without provider or credential fallbacks. */
export async function resolveNanocodexRoute(
  ctx: SettingsContext,
  options: AgentOptions,
): Promise<ResolvedNanocodexRoute> {
  const provider = options.provider;
  const model = options.model;
  if (!provider || !model) {
    throw new Error(
      "Nanocodex requires an explicit AgentOptions.provider and AgentOptions.model",
    );
  }
  if (!isSupportedModel(model)) {
    throw new Error(
      `Nanocodex does not support model ${JSON.stringify(model)}`,
    );
  }

  const configured = settingsValue(ctx).providers[provider];
  if (!configured) {
    throw new Error(
      `Nanocodex route ${JSON.stringify(provider)} is not configured`,
    );
  }
  const api = normalizedApi(provider, configured.api);
  if (!isSupportedRoute(provider, api)) {
    throw new Error(
      `Nanocodex does not support route ${JSON.stringify(provider)} with api ${JSON.stringify(configured.api)}`,
    );
  }
  if (!configured.apiKeyEnv) {
    throw new Error(
      `Nanocodex route ${JSON.stringify(provider)} must declare apiKeyEnv in ${SETTINGS_NAMESPACE}`,
    );
  }

  let ref: CredentialRef;
  try {
    ref = credentialRef(configured.apiKeyEnv);
  } catch (error) {
    throw new Error(
      `Nanocodex route ${JSON.stringify(provider)} has an invalid credential reference`,
      { cause: error },
    );
  }
  const resolved = await ctx.credentials.resolve(ref);
  if (!resolved?.value) {
    throw new Error(
      `Nanocodex credential ${JSON.stringify(configured.apiKeyEnv)} is not configured for route ${JSON.stringify(provider)}`,
    );
  }

  const selectedThinking = thinking(
    options.reasoningEffort ?? configured.reasoning,
  );
  return {
    provider,
    model,
    apiKey: resolved.value,
    ...(configured.baseURL ? { apiBaseUrl: configured.baseURL } : {}),
    ...(configured.websocketURL
      ? { websocketUrl: configured.websocketURL }
      : {}),
    ...(selectedThinking === undefined ? {} : { thinking: selectedThinking }),
  };
}
