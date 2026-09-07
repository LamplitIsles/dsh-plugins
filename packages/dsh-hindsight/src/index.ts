export { HindsightClient } from "./api.js";
export { DEFAULT_BANK_ID, DEFAULT_RECALL, defaultConfigPath, resolveCompanionConfig } from "./config.js";
export { composeRecallQuery, renderCurrentTimeContext, renderMemoryContext } from "./context.js";
export { createDshHooks } from "./dsh.js";
export { DEFAULT_COMPANION_SETTINGS, normalizeCompanionSettings, SETTINGS_NAMESPACE } from "./settings.js";
export { recentUserText, textOf, transcriptForTurn, transcriptThroughTurn } from "./transcript.js";
export type { CompanionSettings } from "./settings.js";
export type { DshPluginConfig, RecallSettings, RecalledMemory, ResolvedCompanionConfig, TranscriptTurn } from "./types.js";
