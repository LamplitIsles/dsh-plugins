import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

it.each([
  "dsh-hindsight",
  "dsh-mail",
  "dsh-matrix",
  "dsh-speech",
  "dsh-imagegen",
])(
  "%s preserves Client declarations when Host declarations start later",
  async (directory) => {
    const workspace = await mkdtemp(join(tmpdir(), "dsh-build-declarations-"));
    const fixture = join(workspace, "packages", directory);
    try {
      await mkdir(fixture, { recursive: true });
      await cp(join(root, "tsconfig.json"), join(workspace, "tsconfig.json"));
      await symlink(
        join(root, "node_modules"),
        join(workspace, "node_modules"),
        "dir",
      );
      const source = join(root, "packages", directory);
      for (const path of [
        "src",
        "scripts",
        "package.json",
        "tsconfig.json",
        "tsup.config.ts",
      ]) {
        await cp(join(source, path), join(fixture, path), { recursive: true });
      }
      await symlink(
        join(source, "node_modules"),
        join(fixture, "node_modules"),
        "dir",
      );
      await mkdir(join(fixture, "dist"));
      await writeFile(join(fixture, "dist", "stale.js"), "old build");
      await writeFile(join(fixture, "dist", "stale.d.ts"), "old declarations");
      await writeFile(
        join(fixture, "repro.ts"),
        `
import { access } from "node:fs/promises";
import { build } from "tsup";
import config from "./tsup.config.ts";
const options = typeof config === "function" ? await config({}) : config;
const client = options.find((option) => option.platform === "browser");
const host = options.find((option) => option.platform === "node");
if (!client || !host) throw new Error("Expected a Host and Client build");
// Force the worker ordering that exposed the CI race, using the real configs
// and tsup declaration builders. Config evaluation (and cleanup) happens once.
await build({ ...client, config: false, dts: { only: true } });
await access("dist/client.d.cts");
await build({ ...host, config: false, dts: { only: true } });
`,
      );
      execFileSync(
        join(root, "node_modules", ".bin", "tsx"),
        [join(fixture, "repro.ts")],
        {
          cwd: fixture,
          timeout: 45_000,
          stdio: "pipe",
        },
      );
      await expect(
        access(join(fixture, "dist", "client.d.cts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(fixture, "dist", "index.d.ts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(fixture, "dist", "stale.js")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(fixture, "dist", "stale.d.ts")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
  60_000,
);
