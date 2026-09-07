import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALIBABA_CREDENTIAL_REF,
  ALIBABA_MODEL,
  BYTEDANCE_CREDENTIAL_REF,
  BYTEDANCE_ENDPOINT,
  BYTEDANCE_RESOURCE_ID,
  DASHSCOPE_ENDPOINT,
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  MAX_ASR_DATA_URL_BYTES,
  QWEN_ASR_MODEL,
  normalizeSettings,
  profileFromSettings,
  providerProfileKey
} from "../src/settings.js";
import {
  AUDIO_ROUTE_PATH,
  CACHE_FORMAT_VERSION,
  MAX_AUDIO_BYTES,
  SpeechGateway,
  createKeposSpeechService,
  RPC_ENDPOINT,
  SpeechGatewayError,
  audioArtifactPath,
  cacheDigest,
  serveSpeechAudio,
  type BrowserAudioPayload
} from "../src/gateway.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function textResponse(body: string, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(body, { status, headers });
}

function sseResponse(...frames: unknown[]): Response {
  return textResponse(
    frames.map((frame) => `event: 352\ndata: ${JSON.stringify(frame)}`).join("\n\n"),
    200,
    { "content-type": "text/event-stream" }
  );
}

function sessionStore(cwd: string, id = "session-a") {
  return { get: (candidate: string) => candidate === id ? { header: { cwd } } : undefined };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kepos-speech-gateway-"));
  temporaryDirectories.push(directory);
  return directory;
}

const credential = (ref: unknown) => ({ value: ref === ALIBABA_CREDENTIAL_REF || ref === BYTEDANCE_CREDENTIAL_REF ? "secret" : "wrong", source: "test" });

describe("provider-neutral Speech gateway", () => {
  it("normalizes independent defaults and keeps the profile key secret-free", () => {
    expect(normalizeSettings(undefined)).toEqual({ provider: "alibaba", alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    expect(normalizeSettings({ provider: "bytedance", alibabaVoice: "  custom  ", bytedanceVoice: "  voice  " })).toEqual({ provider: "bytedance", alibabaVoice: "custom", bytedanceVoice: "voice" });
    expect(normalizeSettings({ provider: "other", alibabaVoice: "", bytedanceVoice: "x".repeat(129) })).toEqual({ provider: "alibaba", alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    expect(providerProfileKey({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE })).not.toContain("secret");
    expect(profileFromSettings({ provider: "bytedance" })).toMatchObject({ provider: "bytedance", voice: DEFAULT_BYTEDANCE_VOICE, model: BYTEDANCE_RESOURCE_ID, credentialRef: BYTEDANCE_CREDENTIAL_REF });
    expect(cacheDigest("固定身份", { provider: "bytedance", bytedanceVoice: "voice", model: "caller-model", resourceId: "caller-resource" }))
      .toBe(cacheDigest("固定身份", { provider: "bytedance", bytedanceVoice: "voice" }));
  });

  it("sends Alibaba's configured Voice ID directly and caches normalized text", async () => {
    const cwd = await workspace();
    const requests: Array<{ body: any; authorization: string }> = [];
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => credential(ref) },
      getSettings: () => ({ provider: "alibaba", alibabaVoice: "  my-custom-id  " }),
      fetch: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)), authorization: String(new Headers(init?.headers).get("authorization")) });
        return jsonResponse({ output: { audio: { data: "SUQz" } } });
      }
    });
    const first = await gateway.synthesize({ sessionId: "session-a", text: "  你好\n" });
    const second = await gateway.synthesize({ sessionId: "session-a", text: "你好" });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ authorization: "Bearer secret", body: { model: ALIBABA_MODEL, input: { text: "你好", voice: "my-custom-id", language_type: "Chinese" }, parameters: { format: "mp3" }, stream: false } });
    expect(first.url).toContain(`${AUDIO_ROUTE_PATH}/`);
    expect(first.url).not.toContain("base64");
  });

  it("posts ByteDance seed TTS with API-key authentication and fixed audio parameters", async () => {
    const cwd = await workspace();
    let request: { url: string; body: any; headers: Headers } | undefined;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => credential(ref) },
      getSettings: () => ({ provider: "bytedance", bytedanceVoice: "  zh_custom  " }),
      fetch: async (url, init) => {
        request = { url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
        return sseResponse({ code: 0, data: "SUQz" });
      }
    });
    const result = await gateway.synthesize({ sessionId: "session-a", text: "你好" });
    expect(result.bytes).toBe(3);
    expect(BYTEDANCE_ENDPOINT).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse");
    expect(request?.url).toBe(BYTEDANCE_ENDPOINT);
    expect(request?.headers.get("accept")).toBe("text/event-stream");
    expect(request?.headers.get("x-api-key")).toBe("secret");
    expect(request?.headers.get("x-api-resource-id")).toBe(BYTEDANCE_RESOURCE_ID);
    expect(request?.headers.get("x-api-app-key")).toBeNull();
    expect(request?.body).toEqual({ user: { uid: "kepos-speech" }, req_params: { text: "你好", speaker: "zh_custom", audio_params: { format: "mp3", sample_rate: 24000 } } });
  });

  it("concatenates SSE audio frames and accepts a completion frame", async () => {
    const cwd = await workspace();
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd, "s"),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => textResponse(
        'event: 352\ndata: {"code":0,"data":"SUQ="}\n\nevent: 352\ndata: {"code":0,"data":"M0E="}\n\nevent: 152\ndata: {"code":20000000}\n',
        200,
        { "content-type": "text/event-stream" }
      )
    });
    const result = await gateway.synthesize({ sessionId: "s", text: "多帧" });
    expect(result.bytes).toBe(4);
  });

  it("accepts ByteDance SSE metadata frames with null audio data", async () => {
    const cwd = await workspace();
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => textResponse([
        'event: 352\ndata: {"code":0,"message":"","data":"SUQz"}',
        'event: 352\ndata: {"code":0,"message":"","data":null,"sentence":{"text":"private"}}'
      ].join("\n\n"), 200, { "content-type": "text/event-stream" })
    });

    await expect(gateway.synthesize({ sessionId: "session-a", text: "测试" }))
      .resolves.toMatchObject({ bytes: 3 });
  });

  it("classifies malformed, rejected, empty, and oversized provider results without exposing content", async () => {
    const cwd = await workspace();
    const base = { sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getSettings: () => ({ provider: "bytedance" }) };
    const rejected = new SpeechGateway({ ...base, fetch: async () => jsonResponse({ message: "do not expose" }, 403) });
    await expect(rejected.handle(RPC_ENDPOINT, { sessionId: "session-a", text: "你好" }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { message: "provider-rejected" } });
    const malformed = new SpeechGateway({ ...base, fetch: async () => sseResponse({ code: 0, data: "not base64!" }) });
    await expect(malformed.synthesize({ sessionId: "session-a", text: "坏" })).rejects.toMatchObject({ category: "provider-invalid-audio" });
    const business = new SpeechGateway({ ...base, fetch: async () => sseResponse({ code: 3001, message: "private provider detail" }) });
    await expect(business.synthesize({ sessionId: "session-a", text: "拒绝" })).rejects.toMatchObject({ category: "provider-rejected" });
    const empty = new SpeechGateway({ ...base, fetch: async () => sseResponse({ code: 20000000 }) });
    await expect(empty.synthesize({ sessionId: "session-a", text: "空" })).rejects.toMatchObject({ category: "provider-invalid-audio" });
    const oversized = new SpeechGateway({ ...base, fetch: async () => sseResponse({ code: 0, data: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64") }) });
    await expect(oversized.synthesize({ sessionId: "session-a", text: "太大" })).rejects.toMatchObject({ category: "provider-invalid-audio" });
    expect(JSON.stringify(await rejected.handle(RPC_ENDPOINT, { sessionId: "session-a", text: "你好" }, new AbortController().signal))).not.toContain("do not expose");
  });

  it("reports safe ByteDance response and HTTP diagnostics without request text or credentials", async () => {
    const cwd = await workspace();
    const failures: unknown[] = [];
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "provider-secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance", bytedanceVoice: "voice-a" }),
      fetch: async () => sseResponse({ code: 3001, message: "voice-a rejected provider-secret for 私密正文" }),
      onFailure: (failure) => failures.push(failure)
    });

    await expect(gateway.handle(
      RPC_ENDPOINT,
      { sessionId: "session-a", text: "私密正文" },
      new AbortController().signal
    )).resolves.toMatchObject({ ok: false, error: { message: "provider-rejected" } });

    const httpFailure = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "provider-secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance", bytedanceVoice: "voice-a" }),
      fetch: async () => jsonResponse({ code: "Forbidden", message: "provider-secret cannot synthesize 私密正文" }, 403),
      onFailure: (failure) => failures.push(failure)
    });
    await httpFailure.handle(
      RPC_ENDPOINT,
      { sessionId: "session-a", text: "私密正文" },
      new AbortController().signal
    );

    expect(failures).toEqual([
      {
        category: "provider-rejected",
        provider: "bytedance",
        voice: "voice-a",
        stage: "provider-response",
        responseContentType: "text/event-stream",
        responseBytes: expect.any(Number)
      },
      {
        category: "provider-rejected",
        provider: "bytedance",
        voice: "voice-a",
        stage: "http",
        httpStatus: 403,
        responseContentType: "application/json",
        responseBytes: expect.any(Number)
      }
    ]);
    expect(JSON.stringify(failures)).not.toContain("provider-secret");
    expect(JSON.stringify(failures)).not.toContain("私密正文");
  });

  it("reports only a fixed issue category when a ByteDance body cannot be framed", async () => {
    const cwd = await workspace();
    const failures: unknown[] = [];
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "provider-secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => new Response(new Uint8Array([0x1e, 0x7b, 0x22, 0x63, 0x6f, 0x64, 0x65, 0x22, 0x3a, 0x30, 0x7d]), {
        headers: { "content-type": "text/plain" }
      }),
      onFailure: (failure) => failures.push(failure)
    });

    await gateway.handle(RPC_ENDPOINT, { sessionId: "session-a", text: "私密正文" }, new AbortController().signal);

    expect(failures).toEqual([expect.objectContaining({
      category: "provider-invalid-audio",
      responseIssue: "invalid-frame"
    })]);
    expect(JSON.stringify(failures)).not.toContain("1e7b");
    expect(JSON.stringify(failures)).not.toContain("私密正文");
    expect(JSON.stringify(failures)).not.toContain("provider-secret");
  });

  it("reports only a fixed issue category for an invalid SSE frame", async () => {
    const cwd = await workspace();
    const failures: unknown[] = [];
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "provider-secret", source: "test" }) },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => textResponse('event: 352\ndata: {"code":0,"message":"","data":{"audio":"private"}}\n\n', 200, { "content-type": "text/event-stream" }),
      onFailure: (failure) => failures.push(failure)
    });

    await gateway.handle(RPC_ENDPOINT, { sessionId: "session-a", text: "私密正文" }, new AbortController().signal);

    expect(failures).toEqual([expect.objectContaining({
      responseIssue: "invalid-frame"
    })]);
    expect(JSON.stringify(failures)).not.toContain("keys=");
    expect(JSON.stringify(failures)).not.toContain("private");
    expect(JSON.stringify(failures)).not.toContain("私密正文");
  });

  it("resolves only the selected credential and does not perform network I/O when it is absent", async () => {
    const cwd = await workspace();
    const refs: unknown[] = [];
    let fetchCalls = 0;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => { refs.push(ref); return undefined; } },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => { fetchCalls += 1; throw new Error("must not call provider"); }
    });
    await expect(gateway.synthesize({ sessionId: "session-a", text: "没有密钥" })).rejects.toMatchObject({ category: "unavailable" });
    expect(refs).toEqual([BYTEDANCE_CREDENTIAL_REF]);
    expect(fetchCalls).toBe(0);
  });

  it("keeps provider/voice cache identities distinct and reuses workspace artifacts", async () => {
    const cwd = await workspace();
    expect(CACHE_FORMAT_VERSION).toBeGreaterThan(1);
    expect(cacheDigest("同句", { provider: "alibaba", alibabaVoice: "Maia" })).not.toBe(cacheDigest("同句", { provider: "bytedance", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }));
    expect(cacheDigest("同句", { provider: "alibaba", alibabaVoice: "Maia" })).not.toBe(cacheDigest("同句", { provider: "alibaba", alibabaVoice: "Other" }));
    let calls = 0;
    const first = new SpeechGateway({ sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getSettings: () => ({ provider: "alibaba" }), fetch: async () => { calls += 1; return jsonResponse({ output: { audio: { data: "SUQz" } } }); } });
    const expected = await first.synthesize({ sessionId: "session-a", text: "缓存" });
    const second = new SpeechGateway({ sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getSettings: () => ({ provider: "alibaba" }), fetch: async () => { calls += 1; throw new Error("cache miss"); } });
    await expect(second.synthesize({ sessionId: "session-a", text: "缓存" })).resolves.toEqual(expected);
    expect(calls).toBe(1);
    await expect(readFile(audioArtifactPath(cwd, cacheDigest("缓存", { provider: "alibaba" })))).resolves.toEqual(Buffer.from([0x49, 0x44, 0x33]));
  });

  it("coalesces identical misses while keeping profile changes independent", async () => {
    const cwd = await workspace();
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let provider: "alibaba" | "bytedance" = "alibaba";
    const gateway = new SpeechGateway({ sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getSettings: () => ({ provider }), fetch: async () => { calls += 1; await held; return provider === "bytedance" ? sseResponse({ code: 0, data: "SUQz" }) : jsonResponse({ output: { audio: { data: "SUQz" } } }); } });
    const one = gateway.synthesize({ sessionId: "session-a", text: "并发" });
    const two = gateway.synthesize({ sessionId: "session-a", text: "并发" });
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await Promise.all([one, two]);
    provider = "bytedance";
    await gateway.synthesize({ sessionId: "session-a", text: "并发" });
    expect(calls).toBe(2);
  });

  it("serves only a resolved workspace digest", async () => {
    const cwd = await workspace();
    const gateway = new SpeechGateway({ sessions: sessionStore(cwd), credentials: { resolve: async () => ({ value: "secret", source: "test" }) }, getSettings: () => ({ provider: "alibaba" }), fetch: async () => jsonResponse({ output: { audio: { data: "SUQz" } } }) });
    const payload: BrowserAudioPayload = await gateway.synthesize({ sessionId: "session-a", text: "路由" });
    const captured: { status?: number; headers?: Record<string, string> | undefined; body?: unknown } = {};
    const res = { writeHead(status: number, headers?: Record<string, string>) { captured.status = status; captured.headers = headers; }, end(body?: unknown) { captured.body = body; } };
    await serveSpeechAudio({ method: "GET", url: payload.url }, res, sessionStore(cwd));
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
  });

  it("returns a bounded byte payload through the optional Host service and reuses the cache", async () => {
    const cwd = await workspace();
    let calls = 0;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "alibaba", alibabaVoice: "Maia" }),
      fetch: async () => {
        calls += 1;
        return jsonResponse({ output: { audio: { data: "SUQz" } } });
      }
    });
    const service = createKeposSpeechService(gateway);
    const first = await service.synthesize({ sessionId: "session-a", text: "  服务调用\n" });
    const second = await service.synthesize({ sessionId: "session-a", text: "服务调用" });
    expect(first).toEqual({ mediaType: "audio/mpeg", data: new Uint8Array([0x49, 0x44, 0x33]) });
    expect(second).toEqual(first);
    expect(Object.keys(first)).toEqual(["mediaType", "data"]);
    expect(JSON.stringify(first)).not.toContain("kepos-speech/audio");
    expect(calls).toBe(1);
  });

  it("keeps Host service validation and cancellation typed", async () => {
    const cwd = await workspace();
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "alibaba" }),
      fetch: async () => jsonResponse({ output: { audio: { data: "SUQz" } } })
    });
    const service = createKeposSpeechService(gateway);
    await expect(service.synthesize({ sessionId: "missing", text: "你好" })).rejects.toMatchObject({ category: "unavailable" });
    await expect(service.synthesize({ sessionId: "", text: "你好" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(service.synthesize({ text: "你好" } as never)).rejects.toMatchObject({ category: "invalid-input" });
    const controller = new AbortController();
    controller.abort();
    await expect(service.synthesize({ sessionId: "session-a", text: "你好" }, controller.signal)).rejects.toMatchObject({ category: "cancelled" });
    await expect(service.synthesize({ sessionId: "session-a", text: "" })).rejects.toMatchObject({ category: "invalid-input" });
  });

  it("transcribes bounded audio with the fixed Qwen model and normalizes audio annotations", async () => {
    const cwd = await workspace();
    const refs: unknown[] = [];
    let request: { body: any; headers: Headers; signal: AbortSignal | null | undefined } | undefined;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => { refs.push(ref); return { value: "asr-secret", source: "test" }; } },
      // ByteDance remains the selected TTS output, but ASR must still use the
      // shared DashScope credential.
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async (url, init) => {
        request = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init?.signal };
        expect(String(url)).toBe(DASHSCOPE_ENDPOINT);
        return jsonResponse({
          output: {
            choices: [{
              finish_reason: "stop",
              message: {
                annotations: [{ type: "audio_info", language: "zh", emotion: "happy" }],
                content: [{ text: "识别结果" }],
                role: "assistant",
                confidence: 0.99
              }
            }]
          },
          provider_private_field: "must not escape"
        });
      }
    });
    const result = await gateway.transcribe({
      sessionId: "session-a",
      mediaType: "audio/ogg",
      data: new Uint8Array([0, 1, 2, 255]),
      language: "zh"
    });
    expect(result).toEqual({ text: "识别结果", language: "zh", expression: "happy" });
    expect(request?.headers.get("authorization")).toBe("Bearer asr-secret");
    expect(request?.body).toEqual({
      model: QWEN_ASR_MODEL,
      input: { messages: [{ role: "user", content: [{ audio: "data:audio/ogg;base64,AAEC/w==" }] }] },
      parameters: { asr_options: { enable_itn: true, language: "zh" } },
      stream: false
    });
    expect(refs).toEqual([ALIBABA_CREDENTIAL_REF]);
    expect(JSON.stringify(result)).not.toContain("provider_private_field");
    expect(JSON.stringify(result)).not.toContain("asr-secret");
    expect(JSON.stringify(result)).not.toContain("confidence");
  });

  it("accepts the documented synchronous choices shape and omits unknown expression labels", async () => {
    const cwd = await workspace();
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "alibaba" }),
      fetch: async () => jsonResponse({
        output: {
          choices: [{
            message: {
              content: [{ text: "无时码文本" }],
              annotations: [{ type: "audio_info", language: "en", emotion: "not-a-label" }]
            }
          }]
        }
      })
    });
    await expect(gateway.transcribe({ sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([3]) }))
      .resolves.toEqual({ text: "无时码文本", language: "en" });
  });

  it("accepts the exact Base64 Data URL boundary and rejects the next byte before admission", async () => {
    const cwd = await workspace();
    const mediaType = "audio/x-wav";
    const prefixLength = `data:${mediaType};base64,`.length;
    const exactBytes = Math.floor((MAX_ASR_DATA_URL_BYTES - prefixLength) / 4) * 3;
    expect(prefixLength + Math.ceil(exactBytes / 3) * 4).toBe(MAX_ASR_DATA_URL_BYTES);
    const refs: unknown[] = [];
    let requests = 0;
    let observedDataUrlLength = 0;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => { refs.push(ref); return { value: "secret", source: "test" }; } },
      getSettings: () => ({ provider: "alibaba" }),
      fetch: async (_url, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as { input: { messages: Array<{ content: Array<{ audio: string }> }> } };
        observedDataUrlLength = body.input.messages[0]!.content[0]!.audio.length;
        return jsonResponse({ output: { choices: [{ message: { content: [{ text: "边界" }] } }] } });
      }
    });
    await expect(gateway.transcribe({ sessionId: "session-a", mediaType, data: new Uint8Array(exactBytes) }))
      .resolves.toEqual({ text: "边界" });
    expect(refs).toEqual([ALIBABA_CREDENTIAL_REF]);
    expect(requests).toBe(1);
    expect(observedDataUrlLength).toBe(MAX_ASR_DATA_URL_BYTES);
    await expect(gateway.transcribe({ sessionId: "session-a", mediaType, data: new Uint8Array(exactBytes + 1) }))
      .rejects.toMatchObject({ category: "invalid-input" });
    expect(refs).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it("rejects invalid audio and unavailable sessions before credential or provider admission", async () => {
    const cwd = await workspace();
    let credentials = 0;
    let requests = 0;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => { credentials += 1; return { value: "secret", source: "test" }; } },
      getSettings: () => ({ provider: "alibaba" }),
      fetch: async () => { requests += 1; return jsonResponse({ output: { text: "unexpected" } }); }
    });
    const valid = { sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([1]) };
    await expect(gateway.transcribe({ ...valid, mediaType: "text/plain" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.transcribe({ ...valid, data: new Uint8Array(MAX_ASR_DATA_URL_BYTES + 1) })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.transcribe({ ...valid, data: [] })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.transcribe({ ...valid, language: "xx" })).rejects.toMatchObject({ category: "invalid-input" });
    await expect(gateway.transcribe({ ...valid, sessionId: "missing" })).rejects.toMatchObject({ category: "unavailable" });
    expect(credentials).toBe(0);
    expect(requests).toBe(0);
  });

  it("fails safely for a missing shared credential and never calls the provider", async () => {
    const cwd = await workspace();
    const refs: unknown[] = [];
    let requests = 0;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async (ref) => { refs.push(ref); return undefined; } },
      getSettings: () => ({ provider: "bytedance" }),
      fetch: async () => { requests += 1; throw new Error("must not call provider"); }
    });
    await expect(gateway.transcribe({ sessionId: "session-a", mediaType: "audio/wav", data: new Uint8Array([1, 2]) }))
      .rejects.toMatchObject({ category: "unavailable", diagnostic: { stage: "credential" } });
    expect(refs).toEqual([ALIBABA_CREDENTIAL_REF]);
    expect(requests).toBe(0);
  });

  it("classifies malformed and rejected ASR responses without exposing body fields", async () => {
    const cwd = await workspace();
    const failures: unknown[] = [];
    const base = {
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "provider-secret", source: "test" }) },
      getSettings: () => ({ provider: "alibaba" as const }),
      onFailure: (failure: unknown) => failures.push(failure)
    };
    const malformed = new SpeechGateway({ ...base, fetch: async () => jsonResponse({ output: { text: 42, details: "private transcript" } }) });
    await expect(malformed.transcribe({ sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([1]) }))
      .rejects.toMatchObject({ category: "provider-invalid-transcription" });
    const rejected = new SpeechGateway({
      ...base,
      fetch: async () => jsonResponse({ error: "provider-secret rejected private transcript" }, 429)
    });
    await expect(rejected.transcribe({ sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([1]) }))
      .rejects.toMatchObject({ category: "provider-rejected" });
    expect(JSON.stringify(failures)).not.toContain("provider-secret");
    expect(JSON.stringify(failures)).not.toContain("private transcript");
  });

  it("propagates cancellation to DashScope and classifies an aborted request", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    const gateway = new SpeechGateway({
      sessions: sessionStore(cwd),
      credentials: { resolve: async () => ({ value: "secret", source: "test" }) },
      getSettings: () => ({ provider: "alibaba" }),
      fetch: async (_url, init) => {
        observedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
    });
    const pending = gateway.transcribe({ sessionId: "session-a", mediaType: "audio/mpeg", data: new Uint8Array([1]) }, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: "cancelled" });
  });
});
