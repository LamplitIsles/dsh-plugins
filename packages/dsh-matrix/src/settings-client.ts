import { DEFAULT_SETTINGS, type MatrixSettings } from "./constants.js";

/** Browser-safe settings projection; this module deliberately has no schemastery dependency. */
export function decodeSettings(value: unknown): Partial<MatrixSettings> {
  if (typeof value !== "object" || value === null) return {};
  const input = value as Record<string, unknown>;
  return {
    ...(typeof input.homeserverUrl === "string" ? { homeserverUrl: input.homeserverUrl } : {}),
    ...(typeof input.userId === "string" ? { userId: input.userId } : {}),
    ...(typeof input.roomId === "string" ? { roomId: input.roomId } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
    ...(typeof input.respondToAll === "boolean" ? { respondToAll: input.respondToAll } : {})
  };
}

export function normalizeSettings(value: unknown): MatrixSettings {
  const decoded = decodeSettings(value);
  return {
    homeserverUrl: decoded.homeserverUrl ?? DEFAULT_SETTINGS.homeserverUrl,
    userId: decoded.userId ?? DEFAULT_SETTINGS.userId,
    roomId: decoded.roomId ?? DEFAULT_SETTINGS.roomId,
    workspaceId: decoded.workspaceId ?? DEFAULT_SETTINGS.workspaceId,
    respondToAll: decoded.respondToAll ?? DEFAULT_SETTINGS.respondToAll
  };
}

export interface SettingsValidation {
  valid: boolean;
  issues: Partial<Record<keyof MatrixSettings, string>>;
}

export function validateSettings(value: Partial<MatrixSettings>): SettingsValidation {
  const issues: SettingsValidation["issues"] = {};
  if (!value.homeserverUrl?.trim()) issues.homeserverUrl = "required";
  else {
    try {
      const url = new URL(value.homeserverUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") issues.homeserverUrl = "url";
    } catch {
      issues.homeserverUrl = "url";
    }
  }
  if (!value.userId?.trim()) issues.userId = "required";
  if (!value.roomId?.trim()) issues.roomId = "required";
  if (!value.workspaceId?.trim()) issues.workspaceId = "required";
  return { valid: Object.keys(issues).length === 0, issues };
}
