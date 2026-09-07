import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigration, buildPlan, type MigrationOptions } from "../scripts/migrate-identities.js";

const fixtures: string[] = [];

async function fixture(settings: string, credentials: string, profile?: Record<string, unknown>): Promise<{ root: string; options: MigrationOptions; backup: string }> {
  const root = await mkdirFixture();
  const dshHome = join(root, "dsh-home");
  const profileDirectory = join(dshHome, "profiles", "web");
  await mkdir(profileDirectory, { recursive: true });
  const settingsPath = join(dshHome, "settings.yaml");
  const credentialsPath = join(dshHome, ".credentials.yaml");
  await writeFile(settingsPath, settings, "utf8");
  await writeFile(credentialsPath, credentials, "utf8");
  await chmod(settingsPath, 0o640);
  await chmod(credentialsPath, 0o600);
  if (profile !== undefined) await writeFile(join(profileDirectory, "package.json"), JSON.stringify(profile), "utf8");
  return {
    root,
    options: { dshHome, profile: "web" },
    backup: join(root, "backup"),
  };
}

async function mkdirFixture(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "dsh-identity-migration-test-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("targeted identity migration", () => {
  it("preserves settings, exact credential values, comments, and modes while mapping the active voice", async () => {
    const state = await fixture(
      "# retain this comment\nother:\n  keep: true\nkepos-speech:\n  provider: bytedance\n  voice: legacy-voice\nkepos-hindsight:\n  bankId: user-bank\n",
      "version: 1\nrefs:\n  OTHER_KEY: unrelated-secret\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n  KEPOS_SPEECH_VOLCENGINE_API_KEY: volcengine-secret\n",
      {
        dependencies: {
          "@lamplitisles/kepos-speech": "link:../speech",
          "@lamplitisles/kepos-hindsight": "link:../hindsight",
          "@lamplitisles/dsh-companion": "link:../companion",
          "@lamplitisles/dsh-mail": "link:../mail",
        },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@lamplitisles/kepos-speech", "@lamplitisles/dsh-companion", "@lamplitisles/dsh-mail"] } },
      },
    );
    const settingsPath = join(state.options.dshHome, "settings.yaml");
    const credentialsPath = join(state.options.dshHome, ".credentials.yaml");
    const beforeSettings = await readFile(settingsPath, "utf8");
    const beforeCredentials = await readFile(credentialsPath, "utf8");

    const result = await applyMigration(state.options, state.backup);
    expect(result.applied).toBe(true);
    expect(result.changedFiles).toEqual([settingsPath, credentialsPath]);
    expect(parse(await readFile(settingsPath, "utf8"))).toEqual({
      other: { keep: true },
      "dsh-speech": { provider: "bytedance", bytedanceVoice: "legacy-voice" },
      "dsh-hindsight": { bankId: "user-bank" },
    });
    expect(await readFile(settingsPath, "utf8")).toContain("# retain this comment");
    expect(parse(await readFile(credentialsPath, "utf8"))).toEqual({
      version: 1,
      refs: {
        OTHER_KEY: "unrelated-secret",
        DSH_SPEECH_DASHSCOPE_API_KEY: "dashscope-secret",
        DSH_SPEECH_VOLCENGINE_API_KEY: "volcengine-secret",
      },
    });
    expect(await readFile(join(state.backup, "settings.yaml"), "utf8")).toBe(beforeSettings);
    expect(await readFile(join(state.backup, ".credentials.yaml"), "utf8")).toBe(beforeCredentials);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o640);
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(state.backup, "settings.yaml"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(state.backup, ".credentials.yaml"))).mode & 0o777).toBe(0o600);
  });

  it("reports the five scoped link targets while preserving unrelated profile bundles", async () => {
    const state = await fixture(
      "dsh-speech:\n  provider: alibaba\n  alibabaVoice: Maia\ndsh-hindsight:\n  bankId: user-bank\n",
      "version: 1\nrefs:\n  DSH_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
      {
        dependencies: { "@lamplitisles/dsh-companion": "link:../companion", "@lamplitisles/dsh-mail": "link:../mail" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@lamplitisles/dsh-companion", "@lamplitisles/dsh-mail"] } },
      },
    );
    const plan = await buildPlan(state.options);
    expect(plan.files.every((file) => !file.changed)).toBe(true);
    expect(plan.profileReconciliation.removeDependencies).toEqual([]);
    expect(plan.profileReconciliation.linkPackages).toEqual([
      "@lamplitisles/dsh-speech",
      "@lamplitisles/dsh-hindsight",
      "@lamplitisles/dsh-matrix",
      "@lamplitisles/dsh-companion",
      "@lamplitisles/dsh-imagegen",
    ]);
    expect(plan.profileReconciliation.preservedBundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@lamplitisles/dsh-mail",
    ]);
  });

  it("is a byte-preserving no-op for an already migrated profile", async () => {
    const state = await fixture(
      "dsh-speech:\n  provider: alibaba\n  alibabaVoice: Maia\ndsh-hindsight:\n  bankId: user-bank\n",
      "version: 1\nrefs:\n  DSH_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const settingsPath = join(state.options.dshHome, "settings.yaml");
    const credentialsPath = join(state.options.dshHome, ".credentials.yaml");
    const before = await Promise.all([readFile(settingsPath, "utf8"), readFile(credentialsPath, "utf8")]);
    const result = await applyMigration(state.options, state.backup);
    expect(result.applied).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(await Promise.all([readFile(settingsPath, "utf8"), readFile(credentialsPath, "utf8")])).toEqual(before);
  });

  it("accepts missing optional legacy records without creating namespaces or refs", async () => {
    const state = await fixture(
      "unrelated:\n  value: stays\n",
      "version: 1\nrefs:\n  OTHER_KEY: unrelated-secret\n",
    );
    const plan = await buildPlan(state.options);
    expect(plan.files).toEqual([
      expect.objectContaining({ exists: true, changed: false, actions: [] }),
      expect.objectContaining({ exists: true, changed: false, actions: [] }),
    ]);
  });

  it("rejects conflicting Speech targets before changing either document", async () => {
    const state = await fixture(
      "kepos-speech:\n  provider: alibaba\n  voice: legacy-voice\ndsh-speech:\n  provider: alibaba\n  alibabaVoice: configured-voice\n",
      "version: 1\nrefs:\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const settingsPath = join(state.options.dshHome, "settings.yaml");
    const credentialsPath = join(state.options.dshHome, ".credentials.yaml");
    const before = await Promise.all([readFile(settingsPath, "utf8"), readFile(credentialsPath, "utf8")]);
    await expect(applyMigration(state.options, state.backup)).rejects.toThrow("conflicting Speech voice");
    expect(await Promise.all([readFile(settingsPath, "utf8"), readFile(credentialsPath, "utf8")])).toEqual(before);
  });

  it("preserves an equal provider-specific voice in an old-only namespace", async () => {
    const state = await fixture(
      "kepos-speech:\n  provider: bytedance\n  voice: legacy-voice\n  bytedanceVoice: legacy-voice\n",
      "version: 1\nrefs:\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const result = await applyMigration(state.options, state.backup);
    expect(result.applied).toBe(true);
    expect(parse(await readFile(join(state.options.dshHome, "settings.yaml"), "utf8"))).toEqual({
      "dsh-speech": { provider: "bytedance", bytedanceVoice: "legacy-voice" },
    });
  });

  it("preserves an equal provider-specific voice while merging namespaces", async () => {
    const state = await fixture(
      "kepos-speech:\n  provider: bytedance\n  voice: legacy-voice\ndsh-speech:\n  bytedanceVoice: legacy-voice\n",
      "version: 1\nrefs:\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const result = await applyMigration(state.options, state.backup);
    expect(result.applied).toBe(true);
    expect(parse(await readFile(join(state.options.dshHome, "settings.yaml"), "utf8"))).toEqual({
      "dsh-speech": { bytedanceVoice: "legacy-voice", provider: "bytedance" },
    });
  });

  it("rejects conflicting provider-specific voice in an old-only namespace before writing", async () => {
    const state = await fixture(
      "kepos-speech:\n  provider: alibaba\n  voice: legacy-voice\n  alibabaVoice: configured-voice\n",
      "version: 1\nrefs:\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const settingsPath = join(state.options.dshHome, "settings.yaml");
    const before = await readFile(settingsPath, "utf8");
    await expect(applyMigration(state.options, state.backup)).rejects.toThrow("conflicting Speech voice");
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("rejects an unsupported legacy voice in the target namespace", async () => {
    const state = await fixture(
      "dsh-speech:\n  provider: alibaba\n  voice: obsolete-voice\n",
      "version: 1\nrefs:\n  DSH_SPEECH_DASHSCOPE_API_KEY: dashscope-secret\n",
    );
    const settingsPath = join(state.options.dshHome, "settings.yaml");
    const before = await readFile(settingsPath, "utf8");
    await expect(applyMigration(state.options, state.backup)).rejects.toThrow("unsupported legacy voice");
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("rejects conflicting credential values without exposing either value", async () => {
    const state = await fixture(
      "kepos-speech:\n  provider: alibaba\n  voice: Maia\n",
      "version: 1\nrefs:\n  KEPOS_SPEECH_DASHSCOPE_API_KEY: old-secret\n  DSH_SPEECH_DASHSCOPE_API_KEY: new-secret\n",
    );
    let message = "";
    try {
      await applyMigration(state.options, state.backup);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("conflicting DashScope credential references");
    expect(message).not.toContain("old-secret");
    expect(message).not.toContain("new-secret");
    expect(await readFile(join(state.options.dshHome, ".credentials.yaml"), "utf8")).toContain("old-secret");
  });
});
