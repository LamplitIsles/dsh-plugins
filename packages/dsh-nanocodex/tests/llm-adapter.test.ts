import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { MODEL_CONTEXT_WINDOW, SUPPORTED_MODELS } from "../src/constants.js";
import { NanocodexLlmAdapter } from "../src/llm-adapter.js";

describe("Nanocodex model metadata", () => {
  it("reports catalog entries and the pinned context in resolved metadata", async () => {
    const context = {
      settings: { get: () => undefined },
    } as unknown as Context;
    const adapter = new NanocodexLlmAdapter(context);
    const models = await adapter.listModels("openai");

    expect(models.map((model) => model.id)).toEqual([...SUPPORTED_MODELS]);
    await expect(
      adapter.resolveModel("openai", SUPPORTED_MODELS[0]!),
    ).resolves.toMatchObject({
      context: { contextWindow: MODEL_CONTEXT_WINDOW },
    });
  });
});
