import { describe, expect, it } from "vitest";

import { createProfileSource, createSpeechRpcClient } from "../src/client.js";
import { RPC_CHANNEL, RPC_ENDPOINT } from "../src/rpc.js";

describe("createSpeechRpcClient", () => {
  it("carries text and framework session identity in the RPC envelope", async () => {
    const calls: unknown[][] = [];
    const connection = {
      rpc: {
        call: async (...args: unknown[]) => {
          calls.push(args);
          return {
            ok: true,
            value: {
              mediaType: "audio/mpeg",
              url: "/kepos-speech/audio/a.mp3?sessionId=session-a",
              bytes: 3
            }
          };
        }
      }
    };

    await createSpeechRpcClient(connection as never).synthesize("你好", "session-a");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual([
      RPC_CHANNEL,
      RPC_ENDPOINT,
      { text: "你好", sessionId: "session-a" }
    ]);
  });
});

describe("createProfileSource", () => {
  it("publishes only selected provider-profile changes", () => {
    let value: any = { provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: "byte" };
    const listeners = new Set<() => void>();
    const source = createProfileSource({
      getSnapshot: () => ({ status: "ready", mode: "host", value } as any),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
    });
    const initial = source.getSnapshot();
    let updates = 0;
    const unsubscribe = source.subscribe(() => { updates += 1; });
    value = { ...value, bytedanceVoice: "other" };
    listeners.forEach((listener) => listener());
    expect(source.getSnapshot()).toBe(initial);
    expect(updates).toBe(0);
    value = { ...value, provider: "bytedance" };
    listeners.forEach((listener) => listener());
    expect(source.getSnapshot()).not.toBe(initial);
    expect(updates).toBe(1);
    unsubscribe();
    source.dispose();
  });

  it("does not fabricate a profile until a Host snapshot is ready", () => {
    let snapshot: any = { status: "unavailable", mode: "host", value: undefined };
    const listeners = new Set<() => void>();
    const source = createProfileSource({
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
    });
    let updates = 0;
    source.subscribe(() => { updates += 1; });
    expect(source.getSnapshot()).toBeUndefined();

    snapshot = { status: "ready", mode: "memory", value: { provider: "alibaba", alibabaVoice: "Maia" } };
    listeners.forEach((listener) => listener());
    expect(source.getSnapshot()).toBeUndefined();
    expect(updates).toBe(0);

    snapshot = { status: "ready", mode: "host", value: { provider: "alibaba", alibabaVoice: "Maia" } };
    listeners.forEach((listener) => listener());
    expect(source.getSnapshot()).toBe('["alibaba","qwen3-tts-flash","Maia"]');
    expect(updates).toBe(1);
    source.dispose();
  });
});
