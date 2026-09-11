import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-fs";
import { NanocodexCompactionEngine } from "./compaction-engine.js";
import { NanocodexEngine } from "./engine.js";
import { NanocodexFactory } from "./factory.js";
import {
  configuredNanocodexProviders,
  NanocodexSettingsSchema,
  SETTINGS_NAMESPACE,
} from "./settings.js";
import { PLUGIN_NAME } from "./constants.js";
import { NanocodexLlmAdapter } from "./llm-adapter.js";
import { createApplyPatchTool } from "./apply-patch/tool.js";

export const name = PLUGIN_NAME;
export const inject = [
  "agents",
  "sessions",
  "settings",
  "credentials",
  "llm",
  "attachments",
  "commands",
  "systemPrompt",
  "tools",
  "fs",
] as const;

/** Install the selected Nanocodex AgentFactory and private compaction owner. */
export function apply(ctx: Context): void {
  const settings = ctx.settings.register(
    SETTINGS_NAMESPACE,
    NanocodexSettingsSchema,
    {
      applies: "live",
    },
  );
  const adapter = new NanocodexLlmAdapter(ctx);
  const routes = configuredNanocodexProviders(settings.get());
  const adapterRegistration = ctx.llm.registerAdapter(
    routes.length > 0 ? routes : ["openai"],
    adapter,
  );
  if (routes.length === 0) adapterRegistration.replace([]);
  ctx.effect(
    () =>
      settings.watch((next) => {
        const nextRoutes = configuredNanocodexProviders(next);
        adapterRegistration.replace(nextRoutes);
      }),
    "dsh-nanocodex.settings",
  );
  ctx.llm.registerConfigurableProviders([
    {
      provider: "openai",
      displayName: "OpenAI Responses",
      settingsNs: SETTINGS_NAMESPACE,
      settingsPath: ["providers", "openai"],
      declared: false,
    },
    {
      provider: "openai-codex-responses",
      displayName: "OpenAI Codex Responses",
      settingsNs: SETTINGS_NAMESPACE,
      settingsPath: ["providers", "openai-codex-responses"],
      declared: false,
    },
  ]);
  ctx.systemPrompt.variable(
    "cwd",
    (context) => context.agent?.session.header.cwd,
  );
  const engine = new NanocodexEngine(ctx);
  const patchProgress = new WeakMap<
    object,
    { readonly outcome: import("./apply-patch/tool.js").ApplyPatchOutcome }
  >();
  ctx.effect(() => {
    const unregister = ctx.tools.register(
      createApplyPatchTool({ fs: ctx.fs, ctx }, patchProgress),
    );
    return unregister;
  }, "dsh-nanocodex.apply-patch");
  // CompactionEngine's Service constructor publishes ctx.compaction under the
  // same plugin-owned lifecycle as the factory.
  new NanocodexCompactionEngine(ctx, engine);
  const factory = new NanocodexFactory(ctx, engine);
  ctx.effect(() => {
    const unregister = ctx.agents.setFactory(factory);
    return async () => {
      unregister();
      await factory.disposeAll();
    };
  }, "dsh-nanocodex.factory");
}

export * from "./agent.js";
export * from "./compaction-engine.js";
export * from "./constants.js";
export * from "./engine.js";
export * from "./factory.js";
export * from "./history.js";
export * from "./llm-adapter.js";
export * from "./settings.js";
export * from "./session-id.js";
export * from "./tool-bridge.js";
export {
  applyPatchToFileSystem,
  createApplyPatchTool,
} from "./apply-patch/tool.js";
export { PatchError } from "./apply-patch/errors.js";
export { applyChunks, seekSequence } from "./apply-patch/matcher.js";
export { parsePatch } from "./apply-patch/parser.js";
export type {
  ApplyPatchLimits,
  ApplyPatchOutcome,
  PatchOperationOutcome,
} from "./apply-patch/tool.js";
