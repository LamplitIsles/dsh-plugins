import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  type CodexSettings,
} from "../src/constants.js";
import {
  CodexSettingsSchema,
  normalizeCodexModel,
  validateCodexSettings,
} from "../src/settings.js";

function enabledSettings(
  overrides: Partial<CodexSettings> = {},
): CodexSettings {
  return {
    enabled: true,
    baseURL: "https://codex-gateway.test",
    credentialRef: "CODEX_API_KEY",
    models: [
      {
        id: "gpt-5-codex",
        name: "GPT-5 Codex",
        contextWindow: 262_144,
        maxTokens: 32_768,
      },
    ],
    transport: "auto",
    maxPatchChars: DEFAULT_SETTINGS.maxPatchChars,
    maxPatchFiles: DEFAULT_SETTINGS.maxPatchFiles,
    maxPatchFileBytes: DEFAULT_SETTINGS.maxPatchFileBytes,
    ...overrides,
  };
}

describe("Codex code-mode settings", () => {
  it("defaults to a dormant opt-in route", () => {
    expect(CodexSettingsSchema({} as never)).toEqual(DEFAULT_SETTINGS);
    expect(SETTINGS_NAMESPACE).toBe("dsh-codex-code-mode");
  });

  it("normalizes model display names while preserving explicit capacities", () => {
    expect(
      normalizeCodexModel({
        id: "custom-model",
        name: "",
        contextWindow: 64_000,
        maxTokens: 8_000,
      }),
    ).toEqual({
      id: "custom-model",
      name: "custom-model",
      contextWindow: 64_000,
      maxTokens: 8_000,
    });
  });

  it.each([
    ["baseURL", { baseURL: "not a URL" }, "valid baseURL"],
    ["credentialRef", { credentialRef: "not a POSIX ref" }, "credentialRef"],
    ["models", { models: [] }, "at least one model"],
    [
      "duplicate models",
      { models: [enabledSettings().models[0], enabledSettings().models[0]] },
      "duplicate model",
    ],
  ] as Array<[string, Partial<CodexSettings>, string]>)(
    "rejects enabled settings with an invalid %s",
    (_name, override, message) => {
      expect(() => validateCodexSettings(enabledSettings(override))).toThrow(
        message,
      );
    },
  );

  it("allows invalid dormant placeholders without activating a profile", () => {
    expect(() =>
      validateCodexSettings({
        enabled: false,
        baseURL: "",
        credentialRef: "",
        models: [],
        transport: "auto",
        maxPatchChars: DEFAULT_SETTINGS.maxPatchChars,
        maxPatchFiles: DEFAULT_SETTINGS.maxPatchFiles,
        maxPatchFileBytes: DEFAULT_SETTINGS.maxPatchFileBytes,
      }),
    ).not.toThrow();
  });

  it.each([
    ["maxPatchChars", { maxPatchChars: 0 }],
    ["maxPatchFiles", { maxPatchFiles: 1.5 }],
    ["maxPatchFileBytes", { maxPatchFileBytes: Number.MAX_SAFE_INTEGER + 1 }],
  ] as Array<[string, Partial<CodexSettings>]>)(
    "rejects an invalid %s processing bound even while dormant",
    (_name, override) => {
      expect(() =>
        validateCodexSettings({
          ...DEFAULT_SETTINGS,
          models: [] as CodexSettings["models"],
          ...override,
        }),
      ).toThrow("positive safe integer");
    },
  );

  it("accepts bounded overrides and preserves them through schema parsing", () => {
    expect(
      CodexSettingsSchema({
        maxPatchChars: 128,
        maxPatchFiles: 3,
        maxPatchFileBytes: 256,
      } as never),
    ).toMatchObject({
      maxPatchChars: 128,
      maxPatchFiles: 3,
      maxPatchFileBytes: 256,
    });
  });
});
