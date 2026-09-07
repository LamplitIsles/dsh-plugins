import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { DEFAULT_BANK_ID, normalizeCompanionSettings } from "./settings.js";
import type { CompanionSettings } from "./settings.js";
import type { DshPluginConfig, HindsightFileConfig, RecallSettings, ResolvedCompanionConfig } from "./types.js";

export { DEFAULT_BANK_ID } from "./settings.js";

export const DEFAULT_RECALL: RecallSettings = {
  budget: "low",
  maxTokens: 900,
  types: ["observation", "world", "experience"],
  preferObservations: true,
  topK: 3,
  contextTurns: 2,
  maxQueryChars: 800,
  timeoutMs: 4_000
};

export function defaultConfigPath(): string {
  return process.env.HINDSIGHT_CONFIG || resolve(homedir(), ".hindsight", "coding-agent.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConfig(path: string): HindsightFileConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value as HindsightFileConfig : {};
  } catch {
    return {};
  }
}

function merge<T extends object>(base: T, layer: Partial<T> | undefined): T {
  return { ...base, ...(layer ?? {}) };
}

function recallSettings(...layers: Array<Partial<RecallSettings> | undefined>): RecallSettings {
  const combined = layers.reduce<Partial<RecallSettings>>((result, layer) => ({ ...result, ...(layer ?? {}) }), {});
  const types = Array.isArray(combined.types)
    ? combined.types.filter((type): type is RecallSettings["types"][number] => type === "world" || type === "experience" || type === "observation")
    : DEFAULT_RECALL.types;
  return {
    budget: combined.budget === "mid" || combined.budget === "high" ? combined.budget : "low",
    maxTokens: positiveInteger(combined.maxTokens, DEFAULT_RECALL.maxTokens, 4_000),
    types: types.length ? types : DEFAULT_RECALL.types,
    preferObservations: combined.preferObservations ?? DEFAULT_RECALL.preferObservations,
    topK: positiveInteger(combined.topK, DEFAULT_RECALL.topK, 20),
    contextTurns: positiveInteger(combined.contextTurns, DEFAULT_RECALL.contextTurns, 8),
    maxQueryChars: positiveInteger(combined.maxQueryChars, DEFAULT_RECALL.maxQueryChars, 4_000),
    timeoutMs: positiveInteger(combined.timeoutMs, DEFAULT_RECALL.timeoutMs, 20_000)
  };
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/**
 * Companion routing is explicit and static. The DSH session agent supplies
 * turn data only; it never selects a bank or changes retention behavior.
 */
export function resolveCompanionConfig(
  plugin: DshPluginConfig = {},
  settings: CompanionSettings = normalizeCompanionSettings(undefined)
): ResolvedCompanionConfig {
  const raw = readConfig(plugin.configPath ?? defaultConfigPath());
  const dsh = raw.harnesses?.dsh;
  const layered = merge(raw, dsh);
  const bankId = settings.bankId ?? DEFAULT_BANK_ID;
  const bank = raw.banks?.[bankId];
  const effective = merge(layered, bank);
  const companion = merge(dsh?.companion ?? {}, bank?.companion);
  const apiUrl = effective.apiUrl?.replace(/\/$/, "") ?? "https://api.hindsight.vectorize.io";

  return {
    enabled: effective.disabled !== true,
    apiUrl,
    apiToken: typeof effective.apiToken === "string" && effective.apiToken ? effective.apiToken : undefined,
    bankId,
    retainSessions: effective.retainSessions !== false,
    recall: recallSettings(companion.recall, plugin.recall)
  };
}
