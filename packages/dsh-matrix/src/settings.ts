import z from "@deepseek-ai/schemastery";
import { DEFAULT_SETTINGS, type MatrixSettings } from "./constants.js";

/** Settings are restart-scoped: the locked session and Matrix identity never switch live. */
export const MatrixSettingsSchema: z<MatrixSettings> = z.object({
  homeserverUrl: z.string().default(DEFAULT_SETTINGS.homeserverUrl),
  userId: z.string().default(DEFAULT_SETTINGS.userId),
  roomId: z.string().default(DEFAULT_SETTINGS.roomId),
  workspaceId: z.string().default(DEFAULT_SETTINGS.workspaceId),
  respondToAll: z.boolean().default(DEFAULT_SETTINGS.respondToAll)
});

export { decodeSettings, normalizeSettings, validateSettings } from "./settings-client.js";
export type { SettingsValidation } from "./settings-client.js";
