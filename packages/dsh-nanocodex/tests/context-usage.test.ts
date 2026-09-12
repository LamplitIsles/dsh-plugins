import type { AgentEvent } from "nanocodex/node";
import { describe, expect, it } from "vitest";
import { modelCallUsage, normalizeTokenUsage } from "../src/output.js";

function completed(usage: unknown, type = "model.call.completed"): AgentEvent {
  return {
    protocol_version: 1,
    request_id: "fixture",
    seq: 1,
    type,
    payload: { usage },
  };
}

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
};

describe("Nanocodex context usage", () => {
  it("converts Responses cache-inclusive input to disjoint DSH buckets", () => {
    expect(modelCallUsage(completed(usage))).toEqual({
      inputTokens: 50,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    });
  });

  it("uses the current request without accumulating earlier requests", () => {
    modelCallUsage(completed(usage));
    expect(
      modelCallUsage(
        completed({ input_tokens: 30, output_tokens: 2, total_tokens: 32 }),
      ),
    ).toEqual({ inputTokens: 30, outputTokens: 2, totalTokens: 32 });
  });

  it("shares cache-aware normalization with ancillary one-shot usage", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
      }),
    ).toEqual({
      inputTokens: 50,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
    });
  });

  it("ignores warmup and compaction usage as context anchors", () => {
    expect(
      modelCallUsage(completed(usage, "model.warmup.completed")),
    ).toBeUndefined();
    expect(
      modelCallUsage(completed(usage, "model.compaction.completed")),
    ).toBeUndefined();
  });

  it.each([null, {}, { input_tokens: -1, output_tokens: 2 }])(
    "ignores missing or invalid provider usage %j",
    (value) => {
      expect(modelCallUsage(completed(value))).toBeUndefined();
    },
  );
});
