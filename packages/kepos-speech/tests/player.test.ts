import { describe, expect, it } from "vitest";
import { act, create } from "react-test-renderer";
import { createElement } from "react";

import { SpeechAudioPlayer, SpeechPlayer, clearSpeechPreparationCache } from "../src/player.js";
import type { BrowserAudioPayload } from "../src/gateway.js";

const payload: BrowserAudioPayload = { mediaType: "audio/mpeg", url: "/kepos-speech/audio/a.mp3?sessionId=session-a", bytes: 3 };

describe("tagged Speech player", () => {
  it("prefetches audio when the finalized message mounts and renders a native player", async () => {
    let calls = 0;
    let root: ReturnType<typeof create> | undefined;
    const client = { synthesize: async (_text: string, sessionId: string) => { calls += 1; expect(sessionId).toBe("session-a"); return payload; } };
    clearSpeechPreparationCache(client);
    await act(async () => {
      root = create(createElement(SpeechAudioPlayer, {
        text: "你好",
        transcript: "你好",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    const audio = root!.root.findByType("audio");
    expect(audio.props.controls).toBe(true);
    expect(audio.props.preload).toBe("metadata");
    expect(audio.props.src).toBe(payload.url);
    root!.unmount();
  });

  it("shares successful and in-flight preparation by session, voice, and normalized text", async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      synthesize: async () => {
        calls += 1;
        await held;
        return payload;
      }
    };
    clearSpeechPreparationCache(client);
    const one = new SpeechPlayer(client);
    const two = new SpeechPlayer(client);
    const first = one.prepare("  你好\n", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    const second = two.prepare("你好", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(one.preparedUrl("你好", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a")).toBe(payload.url);
    expect(two.preparedUrl("你好", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a")).toBe(payload.url);
    one.dispose();
    two.dispose();
  });

  it("keeps page preparation separate for different provider profiles", async () => {
    let calls = 0;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    clearSpeechPreparationCache(client);
    const alibaba = new SpeechPlayer(client);
    const bytedance = new SpeechPlayer(client);
    await Promise.all([
      alibaba.prepare("同一句", '["alibaba","qwen3-tts-flash","Maia"]', "session-a"),
      bytedance.prepare("同一句", '["bytedance","seed-tts-2.0","voice"]', "session-a")
    ]);
    expect(calls).toBe(2);
    expect(alibaba.preparedUrl("同一句", '["alibaba","qwen3-tts-flash","Maia"]', "session-a")).toBe(payload.url);
    expect(bytedance.preparedUrl("同一句", '["bytedance","seed-tts-2.0","voice"]', "session-a")).toBe(payload.url);
    alibaba.dispose();
    bytedance.dispose();

    const remountedAlibaba = new SpeechPlayer(client);
    await remountedAlibaba.prepare("同一句", '["alibaba","qwen3-tts-flash","Maia"]', "session-a");
    expect(calls).toBe(2);
    expect(remountedAlibaba.preparedUrl("同一句", '["alibaba","qwen3-tts-flash","Maia"]', "session-a")).toBe(payload.url);
    remountedAlibaba.dispose();
  });

  it("keeps shared generation alive after disposal and lets a later mount reuse it", async () => {
    let settle!: (value: BrowserAudioPayload) => void;
    let calls = 0;
    const client = { synthesize: async () => { calls += 1; return new Promise<BrowserAudioPayload>((resolve) => { settle = resolve; }); } };
    clearSpeechPreparationCache(client);
    const first = new SpeechPlayer(client);
    const pending = first.prepare("稍等", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.dispose();
    settle(payload);
    await pending;
    const second = new SpeechPlayer(client);
    await second.prepare("稍等", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    expect(calls).toBe(1);
    expect(second.preparedUrl("稍等", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a")).toBe(payload.url);
    second.dispose();
  });

  it("renders a remounted prepared passage as ready on its first frame", async () => {
    let calls = 0;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    clearSpeechPreparationCache(client);
    let first: ReturnType<typeof create> | undefined;
    await act(async () => {
      first = create(createElement(SpeechAudioPlayer, {
        text: "已经准备",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    first!.unmount();

    let remounted: ReturnType<typeof create> | undefined;
    act(() => {
      remounted = create(createElement(SpeechAudioPlayer, {
        text: "已经准备",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
    });

    expect(calls).toBe(1);
    expect(remounted!.root.findByType("audio").props.src).toBe(payload.url);
    remounted!.unmount();
  });

  it("does not share page preparation when no ready profile exists", async () => {
    let calls = 0;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    clearSpeechPreparationCache(client);
    let first: ReturnType<typeof create> | undefined;
    await act(async () => {
      first = create(createElement(SpeechAudioPlayer, { text: "远程", sessionId: "session-a", client }));
      await Promise.resolve();
      await Promise.resolve();
    });
    first!.unmount();

    let second: ReturnType<typeof create> | undefined;
    await act(async () => {
      second = create(createElement(SpeechAudioPlayer, { text: "远程", sessionId: "session-a", client }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    second!.unmount();
  });

  it("removes failed preparation so a later occurrence can retry", async () => {
    let calls = 0;
    const client = {
      synthesize: async () => {
        calls += 1;
        if (calls === 1) throw new Error("unavailable");
        return payload;
      }
    };
    clearSpeechPreparationCache(client);
    const first = new SpeechPlayer(client);
    await first.prepare("重试", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    expect(first.getSnapshot().status).toBe("error");
    const second = new SpeechPlayer(client);
    await second.prepare("重试", "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", "session-a");
    expect(calls).toBe(2);
    expect(second.getSnapshot().status).toBe("ready");
    first.dispose();
    second.dispose();
  });

  it("keeps an already prepared player stable when the selected voice changes", async () => {
    let calls = 0;
    let root: ReturnType<typeof create> | undefined;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    clearSpeechPreparationCache(client);
    await act(async () => {
      root = create(createElement(SpeechAudioPlayer, { text: "同一句", profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", sessionId: "session-a", client }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const originalSrc = root!.root.findByType("audio").props.src;
    await act(async () => {
      root!.update(createElement(SpeechAudioPlayer, { text: "同一句", profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Other\"]", sessionId: "session-a", client }));
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(root!.root.findByType("audio").props.src).toBe(originalSrc);
    root!.unmount();
  });

  it("keeps the transcript visible when prefetching fails", async () => {
    let root: ReturnType<typeof create> | undefined;
    const client = { synthesize: async () => { throw new Error("unavailable"); } };
    clearSpeechPreparationCache(client);
    await act(async () => {
      root = create(createElement(SpeechAudioPlayer, {
        text: "你好",
        transcript: "你好（旁白）",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const player = root!.root.findByProps({ "data-speech-state": "error" });
    expect(player.findByProps({ "data-speech-transcript": true }).children.join("")).toContain("你好（旁白）");
    expect(player.findByProps({ role: "status" }).children.join("")).toContain("Audio unavailable");
    root!.unmount();
  });

  it("shows the transcript and forgets a stale cache URL when audio loading fails", async () => {
    let calls = 0;
    const client = { synthesize: async () => { calls += 1; return payload; } };
    clearSpeechPreparationCache(client);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(createElement(SpeechAudioPlayer, {
        text: "缓存已丢失",
        transcript: "缓存已丢失（旁白）",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => root!.root.findByType("audio").props.onError());
    const failed = root!.root.findByProps({ "data-speech-state": "error" });
    expect(failed.findByProps({ "data-speech-transcript": true }).children.join("")).toContain("缓存已丢失（旁白）");
    root!.unmount();

    let remounted: ReturnType<typeof create> | undefined;
    await act(async () => {
      remounted = create(createElement(SpeechAudioPlayer, {
        text: "缓存已丢失",
        profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]",
        sessionId: "session-a",
        client
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toBe(2);
    remounted!.unmount();
  });
});
