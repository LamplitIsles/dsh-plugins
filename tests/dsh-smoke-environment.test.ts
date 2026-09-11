import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { isolatedEnvironment } from "../scripts/dsh-web-smoke.mjs";

it("reuses the invoking pnpm without exposing the operator's state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "dsh-smoke-tooling-test-"));
  try {
    const tooling = join(temp, "tooling");
    const shims = join(temp, "shims");
    await mkdir(tooling);
    await mkdir(shims);
    for (const [directory, body] of [
      [tooling, "printf '12.3.4\\n'"],
      [shims, "echo 'Corepack would download pnpm again' >&2; exit 41"],
    ]) {
      const path = join(directory, "pnpm");
      await writeFile(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
    }
    const sandbox = join(temp, "sandbox");
    await mkdir(sandbox);
    const env = isolatedEnvironment(sandbox, join(sandbox, "dsh-home"), {
      PATH: [shims, process.env.PATH].join(delimiter),
      npm_execpath: join(tooling, "pnpm"),
      HOME: join(temp, "operator-home"),
      DSH_HOME: join(temp, "operator-dsh"),
      COREPACK_HOME: join(temp, "operator-corepack"),
      NODE_AUTH_TOKEN: "test-only-secret",
    });
    expect(
      execFileSync("pnpm", ["--version"], {
        cwd: sandbox,
        env,
        encoding: "utf8",
      }).trim(),
    ).toBe("12.3.4");
    expect(env.HOME).toBe(join(sandbox, "home"));
    expect(env.DSH_HOME).toBe(join(sandbox, "dsh-home"));
    expect(env.npm_config_cache).toBe(join(sandbox, "npm-cache"));
    expect(env.npm_config_store_dir).toBe(join(sandbox, "pnpm-store"));
    expect(env.COREPACK_HOME).toBeUndefined();
    expect(env.NODE_AUTH_TOKEN).toBeUndefined();
    const nested = join(temp, "nested");
    await mkdir(nested);
    expect(
      execFileSync("pnpm", ["--version"], {
        cwd: nested,
        env: isolatedEnvironment(nested, join(nested, "dsh-home"), env),
        encoding: "utf8",
      }).trim(),
    ).toBe("12.3.4");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
