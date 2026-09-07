import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "@lamplitisles/kepos-hindsight";
const PACKAGE_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const DSH_VERSION = "0.1.2-rc.1";

if (!existsSync(join(root, "dist", "dsh.js")) || !existsSync(join(root, "dist", "client.js"))) {
  throw new Error("pack-smoke requires a fresh `pnpm build`");
}

function isolatedEnvironment(temp, dshHome) {
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const testHome = join(temp, "home");
  return {
    ...env,
    HOME: testHome,
    USERPROFILE: testHome,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    npm_config_cache: join(temp, "npm-cache"),
    npm_config_store_dir: join(temp, "pnpm-store"),
    XDG_CACHE_HOME: join(temp, "cache"),
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state"),
  };
}

function dshEntry(env) {
  const configured = process.env.DSH_CLI;
  if (!configured || !existsSync(configured)) throw new Error(`pack-smoke requires DSH_CLI set to the official DSH ${DSH_VERSION} executable`);
  const entry = configured;
  const version = execFileSync(dshInvocation(entry).command, [...dshInvocation(entry).args, "--version"], { cwd: root, encoding: "utf8", env }).trim();
  if (version !== DSH_VERSION) throw new Error(`pack-smoke requires dsh ${DSH_VERSION}, got ${version}`);
  return entry;
}

function dshInvocation(entry) {
  const suffix = "/@deepseek-ai/dsh/lib/bin.js";
  if (entry.endsWith(suffix)) return { command: process.execPath, args: ["--expose-internals", entry] };
  const candidate = resolve(dirname(entry), "..", "@deepseek-ai/dsh/lib/bin.js");
  if (existsSync(candidate)) return { command: process.execPath, args: ["--expose-internals", candidate] };
  return { command: entry, args: [] };
}

function linkDshDependencies(directory, entry) {
  const resolved = resolve(entry);
  const invocation = dshInvocation(resolved);
  const cliEntry = invocation.args.at(-1) ?? resolved;
  let runtimeNodeModules = dirname(dirname(resolved));
  if (!resolved.endsWith("/node_modules/.bin/dsh")) {
    runtimeNodeModules = realpathSync(cliEntry);
    for (let i = 0; i < 6; i += 1) runtimeNodeModules = dirname(runtimeNodeModules);
  }
  const dependencies = join(runtimeNodeModules, ".pnpm", "node_modules");
  if (!existsSync(join(dependencies, "@deepseek-ai", "dsh-tools"))) {
    throw new Error("DSH runtime dependencies are not available");
  }
  symlinkSync(dependencies, join(directory, "node_modules"), "dir");
}

function runDsh(entry, args, cwd, env) {
  const invocation = dshInvocation(entry);
  return execFileSync(invocation.command, [...invocation.args, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function packedManifest(packed) {
  if (Array.isArray(packed)) return packed[0];
  if ("files" in packed || "filename" in packed) return packed;
  return Object.values(packed)[0];
}

function startRuntime(entry, env, cwd) {
  const invocation = dshInvocation(entry);
  const child = spawn(invocation.command, [...invocation.args, "--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  let timer;
  return new Promise((resolveRuntime, rejectRuntime) => {
    const finish = (error, baseUrl) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectRuntime(error);
      else resolveRuntime({ child, baseUrl });
    };
    const readOutput = (chunk) => {
      output += chunk.toString();
      const match = output.match(/dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+)/);
      if (match?.[1]) finish(undefined, match[1]);
    };
    child.stdout?.on("data", readOutput);
    child.stderr?.on("data", readOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`DSH Web runtime exited before ready (${code ?? "?"}/${signal ?? "?"}): ${output}`));
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out waiting for DSH Web runtime: ${output}`));
    }, 30_000);
  });
}

async function stopRuntime(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveStop();
    };
    child.once("exit", finish);
    if (!child.kill("SIGTERM")) finish();
  });
}

async function fetchPageWithSession(startUrl) {
  const first = await fetch(startUrl, { redirect: "manual" });
  const cookie = first.headers.getSetCookie?.()[0]?.split(";", 1)[0];
  const location = first.headers.get("location");
  const pageUrl = location ? new URL(location, startUrl) : new URL(startUrl);
  const headers = cookie ? { cookie } : {};
  const page = await fetch(pageUrl, { headers });
  return { page, cookie, pageUrl };
}

async function jsonRequest(baseUrl, path, body, cookie) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`DSH returned non-JSON from ${path}: ${text.slice(0, 200)}`);
  }
  return { response, value };
}

const temp = mkdtempSync(join(tmpdir(), "kepos-hindsight-pack-"));
let runtime;
try {
  const home = join(temp, "dsh-home");
  const runtimeCwd = join(temp, "runtime-cwd");
  mkdirSync(runtimeCwd, { recursive: true });
  const env = isolatedEnvironment(temp, home);
  const entry = dshEntry(env);
  linkDshDependencies(temp, entry);
  const packed = JSON.parse(execFileSync("pnpm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const filename = packedManifest(packed)?.filename;
  if (typeof filename !== "string") throw new Error("pnpm pack did not return a tarball name");
  const tarball = filename.startsWith("/") ? filename : join(temp, filename);

  runDsh(entry, ["plugin", "--profile", "web", "add", tarball, "--ignore-scripts"], runtimeCwd, env);

  const install = join(home, "profiles", "web");
  const packageDir = join(install, "node_modules", "@lamplitisles", "kepos-hindsight");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION || manifest.dsh?.client?.platform !== "web") {
    throw new Error("installed manifest does not describe the DSH Web bundle");
  }
  const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  if (dshPeers.some(([, version]) => version !== DSH_VERSION) || dshPeers.some(([name]) => name === "@deepseek-ai/dsh-client-runtime")) {
    throw new Error("installed manifest contains a retired or non-rc.1 DSH peer");
  }
  const expectedInject = [
    "@deepseek-ai/dsh-api-remotes",
    "@deepseek-ai/dsh-client-connection",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-settings-plugins",
    "@deepseek-ai/dsh-client-ui-slots",
  ];
  if (JSON.stringify(manifest.dsh?.client?.inject) !== JSON.stringify(expectedInject)) {
    throw new Error("installed manifest has an unexpected rc.1 client provider graph");
  }
  const patch = readFileSync(join(packageDir, "cordis.patch.yml"), "utf8");
  for (const required of ["kepos-hindsight", PACKAGE_NAME, "agents", "settings", "systemPrompt", "tools"]) {
    if (!patch.includes(required)) throw new Error(`Cordis patch is missing ${required}`);
  }
  for (const path of ["dist/dsh.js", "dist/client.js", "cordis.patch.yml"]) {
    if (!existsSync(join(packageDir, path))) throw new Error(`packed plugin is missing ${path}`);
  }

  runtime = await startRuntime(entry, env, runtimeCwd);
  const { page, cookie } = await fetchPageWithSession(runtime.baseUrl);
  if (!page.ok) throw new Error(`installed DSH Web runtime returned ${page.status} for /`);
  const html = await page.text();
  const bootStart = html.indexOf('globalThis["__DSH_BOOT__"]');
  const bootEnd = bootStart < 0 ? -1 : html.indexOf("</script>", bootStart);
  const bootSource = bootStart < 0 || bootEnd < 0 ? "" : html.slice(bootStart, bootEnd);
  const jsonStart = bootSource.indexOf("{");
  const jsonEnd = bootSource.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("DSH Web bootstrap did not expose __DSH_BOOT__");
  const boot = JSON.parse(bootSource.slice(jsonStart, jsonEnd + 1));
  const pluginEntry = boot.entries?.find((candidate) => candidate.id === PACKAGE_NAME);
  if (!pluginEntry?.url) throw new Error("installed plugin is absent from the DSH Web bootstrap entries");

  const clientResponse = await fetch(new URL(pluginEntry.url, runtime.baseUrl));
  if (!clientResponse.ok) throw new Error(`installed DSH client bundle returned ${clientResponse.status}`);
  const clientCode = await clientResponse.text();
  let loaded;
  vm.runInNewContext(clientCode, {
    window: { __ModuleLoader__: { load(spec) { loaded = spec; } } },
  });
  if (
    loaded?.id !== PACKAGE_NAME ||
    typeof loaded.factory !== "function" ||
    !clientCode.includes("data-plugin-css") ||
    clientCode.includes("dsh-client-runtime") ||
    clientCode.includes("createObjectURL")
  ) {
    throw new Error("served client loader or external rc.1 contract is missing");
  }

  const settings = await jsonRequest(runtime.baseUrl, "/api/settings/describe", {
    type: "client-request",
    rpcId: "pack-smoke-settings",
    method: "settings/describe",
    payload: { args: {} },
  }, cookie);
  const settingsEnvelope = settings.value;
  const namespace = settingsEnvelope.result?.value?.namespaces?.find((candidate) => candidate.ns === "kepos-hindsight");
  if (
    !settings.response.ok ||
    settingsEnvelope.type !== "server-response" ||
    settingsEnvelope.rpcId !== "pack-smoke-settings" ||
    settingsEnvelope.result?.ok !== true ||
    namespace?.value?.bankId !== "yuki-memory"
  ) {
    throw new Error(`installed Host Settings registration did not activate: ${JSON.stringify(settings.value)}`);
  }

  console.log(`pack-smoke: installed ${PACKAGE_NAME}; rc.1 Host Settings, Web bootstrap, and client Loader verified`);
} finally {
  if (runtime) await stopRuntime(runtime.child);
  rmSync(temp, { recursive: true, force: true });
}
