import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCompanionConfig } from "../src/config.js";

async function configFile(config: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kepos-hindsight-config-"));
  const path = join(directory, "coding-agent.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe("resolveCompanionConfig", () => {
  it("uses the focused automatic-recall defaults", () => {
    expect(resolveCompanionConfig({ configPath: "/missing/config.json" }).recall).toMatchObject({
      maxTokens: 900,
      preferObservations: true,
      topK: 3
    });
  });

  it("uses the explicit companion bank and leaves missions untouched", async () => {
    const path = await configFile({
      apiUrl: "http://memory.test/",
      mapPathToBank: {
        "/work": "general",
        "/work/yuki": "yuki-bank"
      },
      harnesses: {
        dsh: {
          companion: { recall: { contextTurns: 3, topK: 4 } }
        }
      },
      banks: {
        "yuki-bank": {
          retain_mission: "not read or changed by the plugin",
          disabled: false
        }
      }
    });

    const config = resolveCompanionConfig({ configPath: path }, { bankId: "yuki-bank" });

    expect(config).toMatchObject({
      enabled: true,
      apiUrl: "http://memory.test",
      bankId: "yuki-bank"
    });
    expect(config.recall).toMatchObject({ contextTurns: 3, topK: 4, budget: "low" });
  });

  it("honors shared and bank-level disable switches", async () => {
    const sharedDisabled = await configFile({ disabled: true });
    const bankDisabled = await configFile({
      bankId: "yuki-bank",
      banks: { "yuki-bank": { disabled: true } }
    });

    expect(resolveCompanionConfig({ configPath: sharedDisabled }).enabled).toBe(false);
    expect(resolveCompanionConfig({ configPath: bankDisabled }, { bankId: "yuki-bank" }).enabled).toBe(false);
  });
});
