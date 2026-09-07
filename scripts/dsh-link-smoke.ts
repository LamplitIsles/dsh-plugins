import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const version = "0.1.2-rc.1";

function resolveDshCli(): string {
  const dshCli = process.env.DSH_CLI;
  if (!dshCli || !existsSync(dshCli)) {
    throw new Error("Set DSH_CLI to the official DSH rc.1 executable.");
  }
  return dshCli;
}

const dshCli = resolveDshCli();

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(dshCli, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

const directory = await mkdtemp(join(tmpdir(), "kepos-imagegen-dsh-link-"));
try {
  const home = join(directory, "home");
  const dshHome = join(directory, "dsh-home");
  const workspace = join(directory, "workspace");
  await Promise.all([home, dshHome, workspace].map((path) => mkdir(path)));
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_store_dir: join(directory, "pnpm-store"),
  };
  const profile = "imagegen-link-smoke";
  const source = pathToFileURL(join(root, "packages/dsh-imagegen")).href;

  requireCondition(
    run(["--version"], workspace, env).trim() === version,
    `Expected fixed DSH ${version}.`,
  );
  run(["plugin", "--profile", profile, "add", source], workspace, env);
  const dump = run(["--profile", profile, "--dump-config"], workspace, env);
  requireCondition(
    dump.includes("# == @lamplitisles/dsh-imagegen") &&
      dump.includes("name: '@lamplitisles/dsh-imagegen'") &&
      dump.includes(
        "inject:\n    - attachments\n    - fs\n    - settings\n    - tools",
      ),
    "The fixed DSH CLI did not compose the linked ImageGen bundle.",
  );

  console.log("DSH link smoke passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
