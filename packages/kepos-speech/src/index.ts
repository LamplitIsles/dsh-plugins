import type { Context } from "@deepseek-ai/cordis";

import {
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  SpeechSettingsSchema,
  SETTINGS_NAMESPACE,
} from "./settings.js";
import {
  KEPOS_SPEECH_SERVICE,
  SpeechGateway,
  createKeposSpeechService,
  registerSpeechAudioRoute,
  registerSpeechRpc,
  type KeposSpeechService,
  type SessionResolver
} from "./gateway.js";
import { registerSpeechPrompt } from "./prompt.js";

export const name = "kepos-speech";
export const inject = ["connection", "credentials", "settings", "systemPrompt", "sessions", "webServer"] as const;

type HostContext = Context & {
  connection: { rpc: Parameters<typeof registerSpeechRpc>[0] };
  credentials: { resolve: (ref: ReturnType<typeof import("@deepseek-ai/dsh-credentials").credentialRef>) => Promise<{ value: string; source: string } | undefined> };
  settings: {
    register: (namespace: unknown, schema: unknown, options?: unknown) => { get(): unknown };
  };
  systemPrompt: { section: (section: unknown) => () => void };
  sessions: SessionResolver;
  webServer: {
    register: Parameters<typeof registerSpeechAudioRoute>[0]["register"];
  };
  provide: (name: string, value: unknown) => () => void;
};

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(
    SETTINGS_NAMESPACE,
    SpeechSettingsSchema,
    {
      base: {
        provider: DEFAULT_PROVIDER,
        alibabaVoice: DEFAULT_ALIBABA_VOICE,
        bytedanceVoice: DEFAULT_BYTEDANCE_VOICE
      },
      applies: "live"
    }
  );
  const gateway = new SpeechGateway({
    credentials: ctx.credentials,
    sessions: ctx.sessions,
    getSettings: () => settings.get(),
    onFailure: (failure) => console.error("[kepos-speech] synthesis failed", failure)
  });
  registerSpeechRpc(ctx.connection.rpc, gateway);
  ctx.provide(KEPOS_SPEECH_SERVICE, createKeposSpeechService(gateway) satisfies KeposSpeechService);
  ctx.effect(() => registerSpeechAudioRoute(ctx.webServer, ctx.sessions), "kepos-speech: audio route");
  registerSpeechPrompt(ctx);
}

export {
  SpeechGateway,
  SpeechGatewayError,
  KEPOS_SPEECH_SERVICE,
  createKeposSpeechService,
  registerSpeechAudioRoute,
  registerSpeechRpc,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  type KeposSpeechAudio,
  type KeposSpeechService,
  type KeposSpeechSynthesisRequest,
  type KeposSpeechTranscription,
  type KeposSpeechTranscriptionRequest
} from "./gateway.js";
export * from "./core.js";

export default { name, inject, apply };
