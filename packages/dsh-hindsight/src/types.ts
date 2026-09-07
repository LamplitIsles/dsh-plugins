export type RecallBudget = "low" | "mid" | "high";
export type MemoryType = "world" | "experience" | "observation";

export interface RecallSettings {
  budget: RecallBudget;
  maxTokens: number;
  types: MemoryType[];
  preferObservations: boolean;
  topK: number;
  contextTurns: number;
  maxQueryChars: number;
  timeoutMs: number;
}

export interface DshPluginConfig {
  /** Path to the shared Hindsight coding-agent config. */
  configPath?: string;
  recall?: Partial<RecallSettings>;
}

export interface HindsightFileConfig {
  apiUrl?: string;
  apiToken?: string;
  bankId?: string;
  disabled?: boolean;
  retainSessions?: boolean;
  harnesses?: Record<string, HindsightFileConfig>;
  banks?: Record<string, HindsightFileConfig>;
  companion?: {
    recall?: Partial<RecallSettings>;
  };
}

export interface ResolvedCompanionConfig {
  enabled: boolean;
  apiUrl: string;
  apiToken?: string;
  bankId: string;
  retainSessions: boolean;
  recall: RecallSettings;
}

export interface RecalledMemory {
  id?: string;
  text: string;
  type?: MemoryType | string;
  score?: number;
  [key: string]: unknown;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}
