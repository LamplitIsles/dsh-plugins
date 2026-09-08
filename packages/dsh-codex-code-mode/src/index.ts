import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { LlmAdapter, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import {
  PiAiAdapter,
  type ResolvedPiAiProviderProfile,
} from "@deepseek-ai/dsh-llm-pi-ai";
import {
  renderToolsSdk,
  renderToolsSdkPy,
  type JsonSchemaNode,
  type ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type {
  AssembleContext,
  PromptAssembly,
} from "@deepseek-ai/dsh-system-prompt";
import {
  APPLY_PATCH_NAME,
  PLUGIN_NAME,
  PROVIDER_ID,
  SETTINGS_NAMESPACE,
  type CodexSettings,
} from "./constants.js";
import {
  createApplyPatchTool,
  EDIT_TOOL_NAMES,
  type ApplyPatchLimits,
} from "./apply-patch/tool.js";
import type { ApplyPatchOutcome } from "./apply-patch/tool.js";
import {
  createCodexAuth,
  createCodexProfile,
  createCodexProviderLifecycle,
} from "./provider.js";
import { CodexSettingsSchema, validateCodexSettings } from "./settings.js";

export const name = PLUGIN_NAME;
export const inject = [
  "llm",
  "credentials",
  "fs",
  "settings",
  "systemPrompt",
  "tools",
  "sessions",
] as const;

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
  fs: FileSystem;
  tools: ToolRuntime;
  llm: {
    registerAdapter: (
      providers: string[],
      adapter: LlmAdapter,
    ) => (() => void) & { replace(providers: string[]): void };
  };
  on: {
    (
      name: "session/disposed",
      listener: (session: { id: string }) => void,
    ): () => boolean;
    (
      name: "agent/disposed",
      listener: (payload: { agent: object }) => void,
    ): () => boolean;
    (
      name: "system-prompt/assemble",
      listener: (
        assembly: PromptAssembly,
        context: AssemblyContext,
        next: () => Promise<PromptAssembly>,
      ) => Promise<PromptAssembly>,
    ): () => boolean;
  };
};

type AgentLike = {
  readonly options?: { readonly provider?: string };
};

type AssemblyContext = AssembleContext & { readonly agent?: AgentLike };
type ToolSdkSchema = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: JsonSchemaNode;
};

function directToolOrder(name: string): number {
  return name === "run_code" ? 0 : 1;
}

function assemblyProvider(
  assembly: PromptAssembly,
  context: AssemblyContext,
): string | undefined {
  const fromVariables = assembly.variables.provider;
  if (typeof fromVariables === "string") return fromVariables;
  return context.agent?.options?.provider;
}

function sdkSchemas(
  tools: ToolRuntime,
  context: AssemblyContext,
  excluded: ReadonlySet<string>,
): ToolSdkSchema[] {
  const result: ToolSdkSchema[] = [];
  for (const schema of tools.schemas(context.scope)) {
    if (excluded.has(schema.name)) continue;
    const definition = tools.get(schema.name, context.scope);
    if (definition === undefined) continue;
    result.push({
      name: schema.name,
      description: schema.description,
      parameters: structuredClone(schema.parameters),
      output: structuredClone(definition.output.schema),
    });
  }
  return result;
}

function renderSdk(schemas: ToolSdkSchema[], language: unknown): string {
  if (language === "python") return renderToolsSdkPy(schemas);
  if (language !== "typescript")
    throw new Error(
      `dsh-codex-code-mode cannot render tools:sdk for runtime language ${JSON.stringify(language)}`,
    );
  return renderToolsSdk(schemas);
}

function rewriteAssembly(
  assembly: PromptAssembly,
  context: AssemblyContext,
  tools: ToolRuntime,
  runtimeLanguage: unknown,
  provider: string | undefined,
): PromptAssembly {
  const sdkSection = assembly.sections.find(
    (section) => section.name === "tools:sdk",
  );
  if (provider === PROVIDER_ID) {
    const direct = new Set(["run_code", APPLY_PATCH_NAME]);
    const directTools = assembly.tools
      .filter((schema) => direct.has(schema.name))
      .sort(
        (left, right) =>
          directToolOrder(left.name) - directToolOrder(right.name),
      );
    if (
      directTools.length !== 2 ||
      !directTools.some((schema) => schema.name === "run_code") ||
      !directTools.some((schema) => schema.name === APPLY_PATCH_NAME) ||
      sdkSection === undefined
    ) {
      throw new Error(
        'Codex code-mode requires dsh-tools presentation mode "both"; strict "ptc" or native mode cannot expose the apply_patch direct surface',
      );
    }
    const excluded = new Set([
      "run_code",
      APPLY_PATCH_NAME,
      ...EDIT_TOOL_NAMES,
    ]);
    const sdk = renderSdk(
      sdkSchemas(tools, context, excluded),
      runtimeLanguage,
    );
    return {
      ...assembly,
      tools: directTools,
      sections: assembly.sections.map((section) =>
        section.name === "tools:sdk" ? { ...section, text: sdk } : section,
      ),
    };
  }

  const visibleSchemas = tools.schemas(context.scope);
  if (!visibleSchemas.some((schema) => schema.name === APPLY_PATCH_NAME))
    return assembly;
  const withoutPatch = assembly.tools.filter(
    (schema) => schema.name !== APPLY_PATCH_NAME,
  );
  if (sdkSection === undefined) return { ...assembly, tools: withoutPatch };
  const filteredAssembly = { ...assembly, tools: withoutPatch };
  const sdk = renderSdk(
    sdkSchemas(tools, context, new Set(["run_code", APPLY_PATCH_NAME])),
    runtimeLanguage,
  );
  return {
    ...filteredAssembly,
    sections: filteredAssembly.sections.map((section) =>
      section.name === "tools:sdk" ? { ...section, text: sdk } : section,
    ),
  };
}

function buildProfiles(
  settings: CodexSettings,
  lifecycle: ReturnType<typeof createCodexProviderLifecycle>,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  if (!settings.enabled) return new Map();
  return new Map([[PROVIDER_ID, createCodexProfile(settings, lifecycle)]]);
}

function sameLimits(
  left: ApplyPatchLimits,
  right: ApplyPatchLimits | undefined,
): boolean {
  return (
    right !== undefined &&
    left.maxPatchChars === right.maxPatchChars &&
    left.maxPatchFiles === right.maxPatchFiles &&
    left.maxPatchFileBytes === right.maxPatchFileBytes
  );
}

export function apply(ctx: HostContext): void {
  const lifecycle = createCodexProviderLifecycle();
  const tools = ctx.tools;
  const patchServices = { fs: ctx.fs, ctx };
  const patchProgress = new WeakMap<
    object,
    { readonly outcome: ApplyPatchOutcome }
  >();
  const settings = ctx.settings.register<CodexSettings>(
    SETTINGS_NAMESPACE,
    CodexSettingsSchema,
    { applies: "live", validate: validateCodexSettings },
  );
  let active = settings.get().enabled;
  let patchRegistration: (() => void) | undefined;
  let registeredLimits: ApplyPatchLimits | undefined;
  const routeProviders = new WeakMap<object, string | undefined>();
  let stopAssembly: (() => boolean) | undefined;
  let stopAgentListener: (() => boolean) | undefined;
  let stopPatchGuard: (() => void) | undefined;

  {
    stopPatchGuard = tools.guard((execution) => {
      if (!active) return undefined;
      const agent = execution.agent;
      let provider: string | undefined;
      if (agent !== undefined && routeProviders.has(agent)) {
        provider = routeProviders.get(agent);
      } else {
        provider = (agent as AgentLike | undefined)?.options?.provider;
      }
      if (execution.name === APPLY_PATCH_NAME && provider !== PROVIDER_ID)
        return "apply_patch is available only on the selected Codex code-mode route";
      if (provider !== PROVIDER_ID) return undefined;
      if (
        EDIT_TOOL_NAMES.has(execution.name) ||
        (execution.parent === undefined &&
          execution.name !== "run_code" &&
          execution.name !== APPLY_PATCH_NAME)
      ) {
        return "Codex code-mode exposes only run_code and apply_patch as direct tools; use the generated SDK from run_code for other capabilities";
      }
      return undefined;
    });
    stopAssembly = ctx.on(
      "system-prompt/assemble",
      async (assembly, context, next) => {
        const assembled = await next();
        if (!active) return assembled;
        const provider = assemblyProvider(assembled, context);
        if (context.agent !== undefined)
          routeProviders.set(context.agent, provider);
        const runtime = ctx.get("codeRuntime") as
          | { readonly language?: unknown }
          | undefined;
        return rewriteAssembly(
          assembled,
          context,
          tools,
          runtime?.language,
          provider,
        );
      },
    );
    stopAgentListener = ctx.on("agent/disposed", ({ agent }) => {
      routeProviders.delete(agent);
    });
  }
  let profiles = new Map<string, ResolvedPiAiProviderProfile>();
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.fs.processPathFromHostPath(hostPath),
        ref,
      ),
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

  let registration:
    | ReturnType<HostContext["llm"]["registerAdapter"]>
    | undefined;
  let routeRegistered = false;
  const sync = (next: CodexSettings): void => {
    active = next.enabled;
    const nextProfiles = buildProfiles(next, lifecycle);
    profiles = new Map(nextProfiles);
    if (profiles.size > 0) {
      const limits: ApplyPatchLimits = {
        maxPatchChars: next.maxPatchChars,
        maxPatchFiles: next.maxPatchFiles,
        maxPatchFileBytes: next.maxPatchFileBytes,
      };
      if (
        patchRegistration === undefined ||
        !sameLimits(limits, registeredLimits)
      ) {
        patchRegistration?.();
        patchRegistration = tools.register(
          createApplyPatchTool(patchServices, patchProgress, limits),
        );
        registeredLimits = limits;
      }
      if (registration === undefined) {
        registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
        routeRegistered = true;
      } else if (!routeRegistered) {
        registration.replace([PROVIDER_ID]);
        routeRegistered = true;
      }
    } else if (registration !== undefined) {
      patchRegistration?.();
      patchRegistration = undefined;
      registeredLimits = undefined;
      if (routeRegistered) {
        registration.replace([]);
        routeRegistered = false;
      }
    } else {
      patchRegistration?.();
      patchRegistration = undefined;
      registeredLimits = undefined;
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
      stopAssembly?.();
      stopAgentListener?.();
      stopPatchGuard?.();
      patchRegistration?.();
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
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
  APPLY_PATCH_NAME,
  CODE_MODE_TOOL_DESCRIPTION,
  CODE_MODE_GRAMMAR,
  DEFAULT_SETTINGS,
  PROVIDER_ID,
  RUN_CODE_DESCRIPTION,
  RUN_CODE_NAME,
  SETTINGS_NAMESPACE,
} from "./constants.js";
export {
  applyPatchToFileSystem,
  createApplyPatchTool,
} from "./apply-patch/tool.js";
export { PatchError } from "./apply-patch/errors.js";
export { applyChunks, seekSequence } from "./apply-patch/matcher.js";
export { parsePatch } from "./apply-patch/parser.js";
export type {
  ApplyPatchOutcome,
  PatchOperationOutcome,
} from "./apply-patch/tool.js";
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
