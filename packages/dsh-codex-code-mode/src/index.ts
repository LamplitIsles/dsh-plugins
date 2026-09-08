import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import {
  PiAiAdapter,
  type ResolvedPiAiProviderProfile,
} from "@deepseek-ai/dsh-llm-pi-ai";
import {
  PLUGIN_NAME,
  PROVIDER_ID,
  SETTINGS_NAMESPACE,
  type CodexSettings,
} from "./constants.js";
import {
  createCodexAuth,
  createCodexProfile,
  createCodexProviderLifecycle,
} from "./provider.js";
import { CodexSettingsSchema, validateCodexSettings } from "./settings.js";

export const name = PLUGIN_NAME;
export const inject = ["llm", "credentials", "settings", "sessions"] as const;

type HostContext = Context & {
  credentials: {
    resolve: (
      ref: ReturnType<typeof credentialRef>,
    ) =>
      | Promise<{ value: string; source?: string } | undefined>
      | { value: string; source?: string }
      | undefined;
  };
  settings: {
    register: <T>(
      namespace: string,
      schema: unknown,
      options?: {
        base?: Partial<T>;
        applies?: "live" | "restart";
        validate?: (value: T) => void;
      },
    ) => {
      get(): T;
      watch(callback: (next: T, previous: T) => void): () => void;
    };
  };
  llm: {
    registerAdapter: (
      providers: string[],
      adapter: LlmAdapter,
    ) => (() => void) & { replace(providers: string[]): void };
  };
  on: (
    name: "session/disposed",
    listener: (session: { id: string }) => void,
  ) => () => boolean;
};

function buildProfiles(
  settings: CodexSettings,
  lifecycle: ReturnType<typeof createCodexProviderLifecycle>,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  if (!settings.enabled) return new Map();
  return new Map([[PROVIDER_ID, createCodexProfile(settings, lifecycle)]]);
}

export function apply(ctx: HostContext): void {
  const lifecycle = createCodexProviderLifecycle();
  let profiles = new Map<string, ResolvedPiAiProviderProfile>();
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async (_provider, profile) => {
      const reference = profile.apiKeyEnv;
      if (reference === undefined)
        throw new Error(
          "Codex code-mode credential reference is not configured",
        );
      const value = await ctx.credentials.resolve(reference);
      if (value === undefined || value.value.length === 0) {
        throw new Error("Codex code-mode credential is not configured");
      }
      return value.value;
    },
    auth: createCodexAuth(),
  });

  const settings = ctx.settings.register<CodexSettings>(
    SETTINGS_NAMESPACE,
    CodexSettingsSchema,
    { applies: "live", validate: validateCodexSettings },
  );

  let registration:
    | ReturnType<HostContext["llm"]["registerAdapter"]>
    | undefined;
  let routeRegistered = false;
  const sync = (next: CodexSettings): void => {
    const nextProfiles = buildProfiles(next, lifecycle);
    profiles = new Map(nextProfiles);
    if (profiles.size > 0) {
      if (registration === undefined) {
        registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
        routeRegistered = true;
      } else if (!routeRegistered) {
        registration.replace([PROVIDER_ID]);
        routeRegistered = true;
      }
    } else if (registration !== undefined) {
      if (routeRegistered) {
        registration.replace([]);
        routeRegistered = false;
      }
    }
  };
  sync(settings.get());
  const stopWatching = settings.watch((next) => sync(next));
  const stopSessionListener = ctx.on("session/disposed", (session) =>
    lifecycle.disposeSession(String(session.id)),
  );
  ctx.effect(
    () => async () => {
      stopWatching();
      stopSessionListener();
      lifecycle.dispose();
      registration?.();
      registration = undefined;
      routeRegistered = false;
      profiles = new Map();
    },
    `${PLUGIN_NAME}: lifecycle`,
  );
}

export {
  CODE_MODE_TOOL_DESCRIPTION,
  CODE_MODE_GRAMMAR,
  DEFAULT_SETTINGS,
  PROVIDER_ID,
  RUN_CODE_DESCRIPTION,
  RUN_CODE_NAME,
  SETTINGS_NAMESPACE,
} from "./constants.js";
export {
  createCodexProfile,
  mapContextToCodex,
  mapEventsToCanonical,
} from "./provider.js";
export {
  CodexSettingsSchema,
  normalizeCodexModel,
  validateCodexSettings,
} from "./settings.js";
export type {
  CodexModelSettings,
  CodexSettings,
  CodexTransport,
} from "./constants.js";
export default { name, inject, apply };
