import { describe, expect, it, vi } from "vitest";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import {
  configuredNanocodexProviders,
  NanocodexSettingsSchema,
  resolveNanocodexRoute,
} from "../src/settings.js";

function context(settings: unknown, value = "test-secret") {
  const resolve = vi.fn<() => Promise<{ value: string }>>(async () => ({
    value,
  }));
  return {
    ctx: {
      settings: { get: () => settings },
      credentials: { resolve },
    },
    resolve,
  };
}

describe("Nanocodex route resolution", () => {
  it.each(["openai", "openai-codex-responses"] as const)(
    "admits the native Add provider profile for %s",
    async (provider) => {
      const apiKeyEnv = `NATIVE_${provider.replaceAll("-", "_").toUpperCase()}_KEY`;
      const settings = NanocodexSettingsSchema({
        providers: { [provider]: { apiKeyEnv } },
      });
      expect(settings.providers[provider]).toEqual({ apiKeyEnv });
      expect(configuredNanocodexProviders(settings)).toEqual([provider]);

      const fixture = context(settings);
      await expect(
        resolveNanocodexRoute(fixture.ctx, {
          provider,
          model: "gpt-5.6-sol",
        }),
      ).resolves.toMatchObject({
        provider,
        model: "gpt-5.6-sol",
        apiKey: "test-secret",
      });
      expect(fixture.resolve).toHaveBeenCalledTimes(1);
      expect(fixture.resolve).toHaveBeenCalledWith(apiKeyEnv);
    },
  );

  it("requires an explicit supported route and resolves credentials through DSH", async () => {
    const fixture = context({
      providers: {
        openai: {
          apiKeyEnv: "OPENAI_KEY",
          api: "openai-responses",
          baseURL: "https://gateway.test/v1",
          websocketURL: "wss://gateway.test/ws",
          reasoning: "high",
        },
      },
    });
    await expect(
      resolveNanocodexRoute(fixture.ctx, {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: ReasoningEffortId("low"),
      }),
    ).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      apiKey: "test-secret",
      apiBaseUrl: "https://gateway.test/v1",
      websocketUrl: "wss://gateway.test/ws",
      thinking: "low",
    });
    expect(fixture.resolve).toHaveBeenCalledWith("OPENAI_KEY");
  });

  it.each([
    ["missing provider", { model: "gpt-5.6-sol" }, /explicit AgentOptions/iu],
    [
      "unsupported model",
      { provider: "openai", model: "gpt-4" },
      /does not support model/iu,
    ],
    [
      "unconfigured route",
      { provider: "other", model: "gpt-5.6-sol" },
      /not configured/iu,
    ],
  ] as const)(
    "fails before provider work for %s",
    async (_name, options, error) => {
      const fixture = context({ providers: {} });
      await expect(resolveNanocodexRoute(fixture.ctx, options)).rejects.toThrow(
        error,
      );
      expect(fixture.resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects an explicitly unsupported API for a named provider without resolving its secret", async () => {
    const fixture = context({
      providers: {
        openai: { apiKeyEnv: "OPENAI_KEY", api: "anthropic-messages" },
      },
    });
    await expect(
      resolveNanocodexRoute(fixture.ctx, {
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
    ).rejects.toThrow(/does not support route/iu);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary provider even when its API resembles OpenAI", async () => {
    const fixture = context({
      providers: {
        proxy: { apiKeyEnv: "PROXY_KEY", api: "openai-responses" },
      },
    });
    await expect(
      resolveNanocodexRoute(fixture.ctx, {
        provider: "proxy",
        model: "gpt-5.6-sol",
      }),
    ).rejects.toThrow(/does not support route/iu);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
});
