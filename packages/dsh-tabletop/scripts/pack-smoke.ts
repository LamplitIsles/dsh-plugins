import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DSH_RC_VERSION,
  dshInvocation,
  isolatedEnvironment,
  linkDshDependencies,
} from "../../../scripts/dsh-web-smoke.mjs";
import {
  checkPackedFiles,
  packageFor,
  packRelease,
} from "../../../scripts/release-shared.js";

const root = resolve(import.meta.dirname, "../../..");
const entry = packageFor("dsh-tabletop")!;
assert.ok(
  process.env.DSH_CLI,
  `Set DSH_CLI to the official DSH ${DSH_RC_VERSION} executable.`,
);
const cli = resolve(process.env.DSH_CLI);
const invocation = dshInvocation(cli);
const temp = await mkdtemp(join(tmpdir(), "dsh-tabletop-pack-smoke-"));
try {
  assert.deepEqual(checkPackedFiles(root, entry), []);
  const artifact = packRelease(root, entry, temp);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", artifact, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(manifest.name, entry.name);
  const sourceManifest = JSON.parse(
    await readFile(
      join(root, "packages", entry.directory, "package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client, undefined);
  assert.equal(manifest.exports["./client"], undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  assert.ok(!JSON.stringify(manifest).match(/catalog:|workspace:/u));
  assert.equal(
    manifest.peerDependencies["@deepseek-ai/dsh-tools"],
    DSH_RC_VERSION,
  );
  const home = join(temp, "dsh-home");
  const cwd = join(temp, "workspace");
  await mkdir(cwd);
  const env = isolatedEnvironment(temp, home);
  const dsh = (args: string[]) =>
    execFileSync(invocation.command, [...invocation.args, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.equal(dsh(["--version"]).trim(), DSH_RC_VERSION);
  await linkDshDependencies(temp, cli, invocation);
  dsh([
    "plugin",
    "--profile",
    "tabletop-smoke",
    "add",
    artifact,
    "--ignore-scripts",
  ]);
  const config = dsh(["--profile", "tabletop-smoke", "--dump-config"]);
  assert.ok(config.includes(entry.name));
  assert.ok(config.includes("dsh-tabletop"));
  const profile = join(home, "profiles", "tabletop-smoke");
  const runner = join(temp, "loader-runner.mjs");
  await writeFile(
    runner,
    `
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Tools, { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const baseUrl = ${JSON.stringify(pathToFileURL(join(profile, "package.json")).href)};
const require = createRequire(baseUrl);
const host = await import(pathToFileURL(require.resolve(${JSON.stringify(entry.name)})).href);
assert.equal(host.name, "dsh-tabletop");
assert.deepEqual(host.inject, ["tools"]);
assert.equal(host.default, undefined);
const patch = await readFile(require.resolve("@lamplitisles/dsh-tabletop/cordis.patch.yml"), "utf8");
assert.match(patch, /inject: \\[tools\\]/u);
const root = new Context();
root.provide("systemPrompt", { tools: () => () => undefined });
const runtime = root.plugin(Tools);
await runtime;
const loader = root.plugin(Loader, { baseUrl });
await loader;
let id;
try {
  id = await root.loader.create({ id: "dsh-tabletop", name: ${JSON.stringify(entry.name)}, inject: ["tools"] });
  await root.loader.await();
  assert.deepEqual(root.tools.schemas().map(tool => tool.name), ["roll_dice"]);
  const tool = root.tools.get("roll_dice");
  assert.equal(tool.parameters.additionalProperties, false);
  const args = { count: 2, sides: 6, modifier: -1, label: "packed roll" };
  const exec = { signal: new AbortController().signal };
  const result = await tool.execute(args, exec);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
  assert.equal(result.rolls.length, 2);
  assert.ok(result.rolls.every(die => Number.isInteger(die) && die >= 1 && die <= 6));
  assert.deepEqual(result, { ...args, rolls: result.rolls, total: result.rolls[0] + result.rolls[1] - 1 });
  assert.deepEqual(tool.output.render(args, result), [{ type: "text", text: JSON.stringify(result) }]);
  await assert.rejects(() => tool.execute({ sides: 6, count: 101 }, exec));
  await root.loader.remove(id);
  id = undefined;
  assert.deepEqual(root.tools.schemas(), []);
  console.log("tabletop-loader: packed package activated; roll_dice result, rendering, bounds, and unload passed");
} finally {
  if (id !== undefined) await root.loader.remove(id);
  await loader.dispose();
  await runtime.dispose();
}
`,
  );
  execFileSync(process.execPath, ["--expose-internals", runner], {
    cwd: temp,
    env,
    stdio: "inherit",
  });
  console.log(
    JSON.stringify({
      package: entry.name,
      packed: true,
      host: true,
      loader: true,
      tool: "roll_dice",
      unload: true,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
