import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, inject, name } from "../src/index.js";
import { KEPOS_SPEECH_SERVICE, RPC_CHANNEL, RPC_ENDPOINT } from "../src/gateway.js";
import { ALIBABA_CREDENTIAL_REF, DEFAULT_ALIBABA_VOICE, DEFAULT_BYTEDANCE_VOICE, DEFAULT_PROVIDER, SETTINGS_NAMESPACE, SPEECH_SYSTEM_PROMPT } from "../src/core.js";
import { QWEN_ASR_MODEL } from "../src/constants.js";

describe("host plugin composition", () => {
  it("registers native settings, static prompt, the sole RPC channel, and Cordis failure logging", async () => {
    const handleCalls: unknown[][] = [];
    const sectionCalls: unknown[] = [];
    const registerCalls: unknown[][] = [];
    const routeCalls: unknown[] = [];
    const provideCalls: unknown[][] = [];
    const hostError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = (...args: unknown[]) => { handleCalls.push(args); return async () => undefined; };
    const section = (value: unknown) => { sectionCalls.push(value); return () => undefined; };
    const register = (...args: unknown[]) => { registerCalls.push(args); return { get: () => ({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }) }; };
    const webServer = { register: (route: unknown) => { routeCalls.push(route); return () => undefined; } };
    const provide = (...args: unknown[]) => { provideCalls.push(args); return () => undefined; };
    const effect = (callback: () => (() => void)) => callback();
    apply({
      settings: { register },
      credentials: { resolve: async (ref: unknown) => ref === ALIBABA_CREDENTIAL_REF ? { value: "secret", source: "test" } : undefined },
      connection: { rpc: { handle } },
      systemPrompt: { section },
      sessions: { get: () => undefined },
      webServer,
      provide,
      effect
    } as never);
    expect(name).toBe("kepos-speech");
    expect(inject).toEqual(["connection", "credentials", "settings", "systemPrompt", "sessions", "webServer"]);
    expect(registerCalls[0]).toEqual([SETTINGS_NAMESPACE, expect.anything(), { base: { provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }, applies: "live" }]);
    expect(sectionCalls[0]).toEqual(expect.objectContaining({ name: "kepos-speech:tagged-output", text: SPEECH_SYSTEM_PROMPT }));
    expect(handleCalls[0]).toEqual([RPC_CHANNEL, expect.any(Function)]);
    expect(provideCalls[0]).toEqual([KEPOS_SPEECH_SERVICE, expect.objectContaining({ synthesize: expect.any(Function) })]);
    expect(routeCalls[0]).toEqual(expect.objectContaining({ kind: "prefix", path: "/kepos-speech/audio", handler: expect.any(Function) }));
    const handler = handleCalls[0]![1] as (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
    expect(RPC_ENDPOINT).toBe("synthesize");
    await expect(handler("other", { text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "invalid-input" } });
    await expect(handler(RPC_ENDPOINT, { text: "你好", sessionId: "missing-session" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "unavailable" } });
    expect(hostError).toHaveBeenCalledWith("[kepos-speech] synthesis failed", expect.objectContaining({ category: "unavailable" }));
    hostError.mockRestore();
  });

  it("publishes the Host service for its lifetime while preserving the browser RPC payload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kepos-speech-host-service-"));
    const handleCalls: unknown[][] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response(
        JSON.stringify(body.model === QWEN_ASR_MODEL
          ? { output: { choices: [{ message: { content: [{ text: "主机识别" }], annotations: [{ type: "audio_info", language: "zh", emotion: "neutral" }] } }] } }
          : { output: { audio: { data: "SUQz" } } }),
        { headers: { "content-type": "application/json" } }
      );
    });
    const ctx = new Context();
    ctx.provide("connection", { rpc: { handle: (channel: string, handler: unknown) => { handleCalls.push([channel, handler]); return async () => undefined; } } });
    ctx.provide("credentials", { resolve: async () => ({ value: "secret", source: "test" }) });
    ctx.provide("settings", { register: () => ({ get: () => ({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }) }) });
    ctx.provide("systemPrompt", { section: () => () => undefined });
    ctx.provide("sessions", { get: (sessionId: string) => sessionId === "session-a" ? { header: { cwd } } : undefined });
    ctx.provide("webServer", { register: () => () => undefined });

    try {
      apply(ctx as never);
      expect(ctx.get(KEPOS_SPEECH_SERVICE)).toEqual(expect.objectContaining({ synthesize: expect.any(Function) }));
      const handler = handleCalls[0]?.[1] as (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
      const browserResult = await handler(RPC_ENDPOINT, { sessionId: "session-a", text: "你好" }, new AbortController().signal);
      expect(browserResult).toEqual({
        ok: true,
        value: {
          mediaType: "audio/mpeg",
          url: expect.stringMatching(/^\/kepos-speech\/audio\/[a-f0-9]{64}\.mp3\?sessionId=session-a$/),
          bytes: 3
        }
      });
      expect(Object.keys((browserResult as { value: Record<string, unknown> }).value)).toEqual(["mediaType", "url", "bytes"]);
      const service = ctx.get(KEPOS_SPEECH_SERVICE)!;
      await expect(service.transcribe({ sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([1, 2]) }))
        .resolves.toEqual({ text: "主机识别", language: "zh", expression: "neutral" });

      await ctx.fiber.dispose();
      expect(ctx.get(KEPOS_SPEECH_SERVICE)).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
      await ctx.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
