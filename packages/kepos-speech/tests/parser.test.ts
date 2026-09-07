import { describe, expect, it } from "vitest";

import { parseTaggedText, normalizeSpeechText } from "../src/parser.js";

describe("tagged assistant text", () => {
  it("keeps ordinary prose unchanged", () => {
    expect(parseTaggedText("你好，世界。")).toEqual({ segments: [{ kind: "text", text: "你好，世界。" }] });
  });

  it("replaces one valid passage while preserving surrounding prose", () => {
    const parsed = parseTaggedText("开场 [[tts:text]] 你好\n朋友 [[/tts:text]] 收尾");
    expect(parsed.passage?.text).toBe("你好 朋友");
    expect(parsed.segments).toEqual([
      { kind: "text", text: "开场 " },
      { kind: "speech", text: "你好 朋友", transcript: "你好 朋友" },
      { kind: "text", text: " 收尾" }
    ]);
  });

  it("handles a tag split across streaming snapshots by parsing each complete value", () => {
    expect(parseTaggedText("[[tts:text]]半句").passage).toBeUndefined();
    expect(parseTaggedText("[[tts:text]]半句完成[[/tts:text]]").passage?.text).toBe("半句完成");
  });

  it("leaves fenced examples and malformed tags visible", () => {
    expect(parseTaggedText("```md\n[[tts:text]]不要播放[[/tts:text]]\n```").passage).toBeUndefined();
    expect(parseTaggedText("[[tts:text]]未闭合").segments[0]).toEqual({ kind: "text", text: "[[tts:text]]未闭合" });
  });

  it("does not close a four-backtick fence with a three-backtick run", () => {
    const input = "````md\n[[tts:text]]不要播放[[/tts:text]]\n```";
    expect(parseTaggedText(input).passage).toBeUndefined();
  });

  it("does not close an open fence when a marker has trailing text", () => {
    const input = "```\n``` trailing text\n[[tts:text]]不要播放[[/tts:text]]\n```";
    expect(parseTaggedText(input).passage).toBeUndefined();
  });

  it("recognizes only the first valid pair; later tag syntax stays text", () => {
    const parsed = parseTaggedText("[[tts:text]]第一句[[/tts:text]] [[tts:text]]第二句[[/tts:text]]");
    expect(parsed.passage?.text).toBe("第一句");
    expect(parsed.segments.at(-1)).toEqual({ kind: "text", text: " [[tts:text]]第二句[[/tts:text]]" });
  });

  it("rejects an empty or 241-code-point passage", () => {
    expect(parseTaggedText("[[tts:text]][[/tts:text]]").passage).toBeUndefined();
    expect(parseTaggedText(`[[tts:text]]${"你".repeat(241)}[[/tts:text]]`).passage).toBeUndefined();
  });

  it("does not treat nested tag syntax as spoken content", () => {
    const input = "[[tts:text]][[tts:text]]嵌套[[/tts:text]][[/tts:text]]";
    expect(parseTaggedText(input).passage).toBeUndefined();
    expect(parseTaggedText(input).segments[0]).toEqual({ kind: "text", text: input });
  });

  it("normalizes Unicode whitespace", () => {
    expect(normalizeSpeechText("  甲\u00a0\n乙  ")).toBe("甲 乙");
  });
});
