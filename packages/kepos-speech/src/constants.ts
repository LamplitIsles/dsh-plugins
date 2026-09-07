/** Shared settings and provider identity for the host and browser halves. */
export const SETTINGS_NAMESPACE = "kepos-speech";

export const ALIBABA_CREDENTIAL_REF = "KEPOS_SPEECH_DASHSCOPE_API_KEY";
export const BYTEDANCE_CREDENTIAL_REF = "KEPOS_SPEECH_VOLCENGINE_API_KEY";

export const DASHSCOPE_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const ALIBABA_MODEL = "qwen3-tts-flash";
/** Fixed DashScope model used by the Host-only short-audio transcription path. */
export const QWEN_ASR_MODEL = "qwen3-asr-flash";

/** DashScope's Qwen3-ASR-Flash synchronous Base64 Data URL bound. */
export const MAX_ASR_DATA_URL_BYTES = 10 * 1024 * 1024;

/**
 * Audio media types accepted by Qwen3-ASR-Flash's URL/Base64 input. Video
 * containers are deliberately excluded from the Host contract even though
 * the provider can recognize some of them.
 */
export const QWEN_ASR_MEDIA_TYPES = [
  "audio/aac",
  "audio/amr",
  "audio/aiff",
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/x-ms-wma"
] as const;

export type QwenAsrMediaType = (typeof QWEN_ASR_MEDIA_TYPES)[number];

/** Language hints and detected language values documented by Qwen3-ASR. */
export const QWEN_ASR_LANGUAGES = [
  "zh", "yue", "en", "ja", "de", "ko", "ru", "fr", "pt", "ar", "it", "es",
  "hi", "id", "th", "tr", "uk", "vi", "cs", "da", "fil", "fi", "is", "ms", "no", "pl", "sv"
] as const;

export type QwenAsrLanguage = (typeof QWEN_ASR_LANGUAGES)[number];

/** Discrete model-derived speech-expression labels; absence is meaningful. */
export const QWEN_ASR_EXPRESSIONS = [
  "surprised", "neutral", "happy", "sad", "disgusted", "angry", "fearful"
] as const;

export type QwenAsrExpression = (typeof QWEN_ASR_EXPRESSIONS)[number];

export const BYTEDANCE_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse";
export const BYTEDANCE_RESOURCE_ID = "seed-tts-2.0";

export const SPEECH_MAX_CHARS = 240;
export const VOICE_ID_MAX_LENGTH = 128;

export const DEFAULT_PROVIDER = "alibaba" as const;
export const DEFAULT_ALIBABA_VOICE = "Maia";
export const DEFAULT_BYTEDANCE_VOICE = "zh_female_sajiaoxuemei_uranus_bigtts";

export const SPEECH_PROVIDERS = ["alibaba", "bytedance"] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

export interface SpeechSettings {
  provider: SpeechProvider;
  alibabaVoice: string;
  bytedanceVoice: string;
}

/** The normalized provider profile used by synthesis and cache identity. */
export interface SpeechProfile {
  provider: SpeechProvider;
  voice: string;
  /** Provider model/resource identity; never supplied by the browser. */
  model: string;
  credentialRef: string;
}

export function normalizeProvider(value: unknown): SpeechProvider {
  return typeof value === "string" && (SPEECH_PROVIDERS as readonly string[]).includes(value)
    ? value as SpeechProvider
    : DEFAULT_PROVIDER;
}

/** Trim a configured Voice ID while treating malformed values as defaults. */
export function normalizeVoiceId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > VOICE_ID_MAX_LENGTH) return fallback;
  return normalized;
}

export function normalizeSettings(value: unknown): SpeechSettings {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    provider: normalizeProvider(record.provider),
    alibabaVoice: normalizeVoiceId(record.alibabaVoice, DEFAULT_ALIBABA_VOICE),
    bytedanceVoice: normalizeVoiceId(record.bytedanceVoice, DEFAULT_BYTEDANCE_VOICE)
  };
}

export function profileFromSettings(value: unknown): SpeechProfile {
  const settings = normalizeSettings(value);
  if (settings.provider === "bytedance") {
    return {
      provider: "bytedance",
      voice: settings.bytedanceVoice,
      model: BYTEDANCE_RESOURCE_ID,
      credentialRef: BYTEDANCE_CREDENTIAL_REF
    };
  }
  return {
    provider: "alibaba",
    voice: settings.alibabaVoice,
    model: ALIBABA_MODEL,
    credentialRef: ALIBABA_CREDENTIAL_REF
  };
}

/** A secret-free, stable page-memory identity for one normalized profile. */
export function providerProfileKey(value: unknown): string {
  const profile = profileFromSettings(value);
  return JSON.stringify([profile.provider, profile.model, profile.voice]);
}
