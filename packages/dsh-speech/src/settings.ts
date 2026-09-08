import z from "@deepseek-ai/schemastery";

export * from "./constants.js";

import {
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  SPEECH_PROVIDERS,
  VOICE_ID_MAX_LENGTH,
  type SpeechSettings,
} from "./constants.js";

function voiceSchema(fallback: string) {
  return z
    .transform(
      z.string(),
      (value: string) => {
        const normalized = value.trim();
        // Keep the callback self-contained because Schemastery serializes it.
        if (!normalized || Array.from(normalized).length > 128)
          throw new TypeError("invalid voice id");
        return normalized;
      },
      true,
    )
    .pattern(/\S/u)
    .max(VOICE_ID_MAX_LENGTH)
    .default(fallback)
    .loose(true);
}

const alibabaVoice = voiceSchema(DEFAULT_ALIBABA_VOICE);
const bytedanceVoice = voiceSchema(DEFAULT_BYTEDANCE_VOICE);

const speechSettingsShape = z.object({
  provider: z.union(SPEECH_PROVIDERS).default(DEFAULT_PROVIDER).loose(true),
  alibabaVoice,
  bytedanceVoice,
});

/** Resolve only the current flat provider fields; obsolete unknown keys drop out. */
export const SpeechSettingsSchema: z<SpeechSettings> = z
  .transform(
    speechSettingsShape,
    (value): SpeechSettings => ({
      provider: value.provider ?? DEFAULT_PROVIDER,
      alibabaVoice: value.alibabaVoice ?? DEFAULT_ALIBABA_VOICE,
      bytedanceVoice: value.bytedanceVoice ?? DEFAULT_BYTEDANCE_VOICE,
    }),
    true,
  )
  .default({
    provider: DEFAULT_PROVIDER,
    alibabaVoice: DEFAULT_ALIBABA_VOICE,
    bytedanceVoice: DEFAULT_BYTEDANCE_VOICE,
  })
  .loose(true);

export type { SpeechSettings } from "./constants.js";
