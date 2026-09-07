import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";

import { renderAssistantBlocks } from "../src/client/assistant-node.js";
import type { SpeechRpcClient } from "../src/player.js";

const client: SpeechRpcClient = { synthesize: async () => ({ mediaType: "audio/mpeg", url: "/kepos-speech/audio/a.mp3?sessionId=session-a", bytes: 3 }) };
const t = (key: string) => key;

describe("assistant renderer seam", () => {
  it("interleaves one finalized audio player and leaves ordinary markdown rendered", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([
      { kind: "text", text: "普通 [[tts:text]]你好[[/tts:text]]。" }
    ], { streaming: false, interrupted: false, t, client, profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", sessionId: "session-a" })));
    expect(html).toContain('data-speech-state="idle"');
    expect(html).toContain("普通");
    expect(html).not.toContain("[[tts:text]]");
  });

  it("does not expose a control while streaming or for ordinary text", () => {
    const streaming = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([{ kind: "text", text: "[[tts:text]]稍后[[/tts:text]]" }], { streaming: true, interrupted: false, t, client, profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", sessionId: "session-a" })));
    const ordinary = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([{ kind: "text", text: "只是回答" }], { streaming: false, interrupted: false, t, client, profileKey: "[\"alibaba\",\"qwen3-tts-flash\",\"Maia\"]", sessionId: "session-a" })));
    expect(streaming).not.toContain("data-speech-state");
    expect(ordinary).not.toContain("data-speech-state");
  });

  it("still mounts tagged speech without a ready profile key", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([
      { kind: "text", text: "[[tts:text]]远程朗读[[/tts:text]]" }
    ], { streaming: false, interrupted: false, t, client, sessionId: "session-a" })));
    expect(html).toContain('data-speech-state="idle"');
  });

  it("keeps the pinned Think row and native block path for untagged replies", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, renderAssistantBlocks([
      { kind: "reasoning", text: "先判断\n再回答" },
      { kind: "text", text: "普通回复" }
    ], { streaming: false, interrupted: false, t, sessionId: "session-a" })));
    expect(html).toContain('data-variant="think"');
    expect(html).toContain('data-state="ok"');
    expect(html).toContain("Think");
    expect(html).toContain('data-disclosure-row="true"');
    expect(html).toContain("先判断");
    expect(html).toContain("普通回复");
    expect(html).not.toContain("data-speech-state");
  });
});
