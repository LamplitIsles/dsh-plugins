export const SETTINGS_NAMESPACE = "kepos-hindsight";
export const DEFAULT_BANK_ID = "yuki-memory";

export interface CompanionSettings {
  bankId: string;
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  bankId: DEFAULT_BANK_ID
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accept only the explicit, non-secret companion bank selection. */
export function normalizeCompanionSettings(value: unknown): CompanionSettings {
  const raw = isRecord(value) ? value : {};
  const bankId = typeof raw.bankId === "string" && raw.bankId.trim()
    ? raw.bankId.trim()
    : DEFAULT_BANK_ID;
  return {
    bankId
  };
}
