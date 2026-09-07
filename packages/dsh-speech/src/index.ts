import type { Context } from "@deepseek-ai/cordis";

import {
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  SpeechSettingsSchema,
  SETTINGS_NAMESPACE,
} from "./settings.js";
import {
  DSH_SPEECH_SERVICE,
  SpeechGateway,
  createDshSpeechService,
  registerSpeechAudioRoute,
  registerSpeechRpc,
  type DshSpeechService,
  type SessionResolver
} from "./gateway.js";
import { registerSpeechPrompt } from "./prompt.js";

export const name = "dsh-speech";
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
    onFailure: (failure) => console.error("[dsh-speech] synthesis failed", failure)
  });
  registerSpeechRpc(ctx.connection.rpc, gateway);
  ctx.provide(DSH_SPEECH_SERVICE, createDshSpeechService(gateway) satisfies DshSpeechService);
  ctx.effect(() => registerSpeechAudioRoute(ctx.webServer, ctx.sessions), "dsh-speech: audio route");
  registerSpeechPrompt(ctx);
}

export {
  SpeechGateway,
  SpeechGatewayError,
  DSH_SPEECH_SERVICE,
  createDshSpeechService,
  registerSpeechAudioRoute,
  registerSpeechRpc,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  type DshSpeechAudio,
  type DshSpeechService,
  type DshSpeechSynthesisRequest,
  type DshSpeechTranscription,
  type DshSpeechTranscriptionRequest
} from "./gateway.js";
export * from "./core.js";

export default { name, inject, apply };
