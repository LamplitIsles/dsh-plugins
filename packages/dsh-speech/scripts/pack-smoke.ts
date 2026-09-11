import {
  isolatedEnvironment,
  linkDshDependencies,
} from "../../../scripts/dsh-web-smoke.mjs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
const DSH_VERSION = "0.1.2-rc.1";
if (
  !existsSync(join(root, "dist", "index.js")) ||
  !existsSync(join(root, "dist", "client.js"))
) {
  throw new Error("pack-smoke requires a fresh `pnpm run build`");
}

function dshInvocation(entry: string): { command: string; args: string[] } {
  const packageEntrySuffix = "/@deepseek-ai/dsh/lib/bin.js";
  if (entry.endsWith(packageEntrySuffix)) {
    return { command: process.execPath, args: ["--expose-internals", entry] };
  }
  const candidate = resolve(
    dirname(entry),
    "..",
    "@deepseek-ai/dsh/lib/bin.js",
  );
  if (existsSync(candidate)) {
    return {
      command: process.execPath,
      args: ["--expose-internals", candidate],
    };
  }
  return { command: entry, args: [] };
}

function dshEntry(env: NodeJS.ProcessEnv): string {
  const configured = process.env.DSH_CLI;
  const entry = configured;
  if (!entry || !existsSync(entry)) {
    throw new Error(
      `pack-smoke requires DSH_CLI set to the official DSH ${DSH_VERSION} executable`,
    );
  }
  if (!existsSync(entry))
    throw new Error(`DSH CLI target does not exist: ${entry}`);
  let version = "";
  try {
    const invocation = dshInvocation(resolve(entry));
    version = execFileSync(
      invocation.command,
      [...invocation.args, "--version"],
      { cwd: root, encoding: "utf8", env },
    ).trim();
  } catch {
    throw new Error(
      `pack-smoke could not query dsh ${DSH_VERSION} CLI version`,
    );
  }
  if (version !== DSH_VERSION)
    throw new Error(
      `pack-smoke requires dsh ${DSH_VERSION}, got ${version || "unknown"}`,
    );
  return entry;
}

function startRuntime(
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ child: ChildProcess; baseUrl: string; launchUrl: string }> {
  const invocation = dshInvocation(entry);
  const child = spawn(
    invocation.command,
    [
      ...invocation.args,
      "--profile",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolveRuntime, rejectRuntime) => {
    const finish = (error: Error | undefined, baseUrl?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectRuntime(error);
      else if (baseUrl)
        resolveRuntime({
          child,
          baseUrl: new URL(baseUrl).origin,
          launchUrl: baseUrl,
        });
      else rejectRuntime(new Error("DSH Web runtime exited without a URL"));
    };
    const readOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(
        /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+(?:\/\?token=[^\s\r\n]+)?)/,
      );
      if (match?.[1]) finish(undefined, match[1]);
    };
    child.stdout?.on("data", readOutput);
    child.stderr?.on("data", readOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled)
        finish(
          new Error(
            `DSH Web runtime exited before ready (${code ?? "?"}/${signal ?? "?"}): ${output}`,
          ),
        );
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out waiting for DSH Web runtime: ${output}`));
    }, 30_000);
  });
}

async function stopRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
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

async function jsonRequest(
  baseUrl: string,
  path: string,
  body: unknown,
  cookie: string,
): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `DSH returned non-JSON from ${path}: ${text.slice(0, 200)}`,
    );
  }
  return { response, value };
}

async function authenticateRuntime(runtime: {
  launchUrl: string;
}): Promise<string> {
  const response = await fetch(runtime.launchUrl, { redirect: "manual" });
  if (response.status !== 303)
    throw new Error(
      `DSH Web launch URL returned ${response.status} instead of a browser-auth redirect`,
    );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie)
    throw new Error("DSH Web launch URL did not issue a browser-auth cookie");
  return cookie;
}

const temp = mkdtempSync(join(tmpdir(), "dsh-speech-pack-"));
let runtime:
  | { child: ChildProcess; baseUrl: string; launchUrl: string }
  | undefined;
try {
  const packed = JSON.parse(
    execFileSync(
      "corepack",
      ["pnpm", "pack", "--json", "--pack-destination", temp],
      { cwd: root, encoding: "utf8" },
    ),
  ) as { filename?: string } | Record<string, { filename?: string }>;
  const packedEntry = Array.isArray(packed)
    ? packed[0]
    : "files" in packed || "filename" in packed
      ? packed
      : Object.values(packed)[0];
  const filename = packedEntry?.filename;
  if (!filename) throw new Error("pnpm pack did not produce an artifact");
  const tarball = filename.startsWith("/") ? filename : join(temp, filename);
  const home = join(temp, "dsh-home");
  const runtimeCwd = join(temp, "runtime-cwd");
  mkdirSync(runtimeCwd, { recursive: true });
  const env = isolatedEnvironment(temp, home);
  const entry = dshEntry(env);
  await linkDshDependencies(temp, entry);
  try {
    const invocation = dshInvocation(entry);
    execFileSync(
      invocation.command,
      [
        ...invocation.args,
        "plugin",
        "--profile",
        "web",
        "add",
        tarball,
        "--ignore-scripts",
      ],
      {
        cwd: runtimeCwd,
        stdio: "pipe",
        env,
      },
    );
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? (error as { stderr?: unknown }).stderr
        : undefined;
    const detail = typeof stderr === "string" ? stderr : "";
    throw new Error(
      `failed to install packed plugin into disposable DSH_HOME: ${detail}`,
    );
  }

  const install = join(home, "profiles", "web");
  const packageDir = join(
    install,
    "node_modules",
    "@lamplitisles",
    "dsh-speech",
  );
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as {
    name: string;
    peerDependencies?: Record<string, string>;
    dsh?: { client?: { platform?: string; inject?: string[] } };
  };
  if (
    manifest.name !== "@lamplitisles/dsh-speech" ||
    manifest.dsh?.client?.platform !== "web"
  ) {
    throw new Error("installed manifest does not describe the DSH Web bundle");
  }
  if (manifest.peerDependencies?.["@deepseek-ai/cordis"] !== "4.0.2") {
    throw new Error("packed manifest is not pinned to Cordis 4.0.2");
  }
  for (const [name, version] of Object.entries(
    manifest.peerDependencies ?? {},
  )) {
    if (name.startsWith("@deepseek-ai/dsh-") && version !== DSH_VERSION) {
      throw new Error(
        `packed manifest has a non-rc.1 DSH peer: ${name}@${version}`,
      );
    }
  }
  const injected = manifest.dsh?.client?.inject ?? [];
  for (const required of [
    "@deepseek-ai/dsh-client-ui-chat",
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-ui-session",
  ]) {
    if (!injected.includes(required))
      throw new Error(
        `packed manifest is missing rc.1 client service ${required}`,
      );
  }
  for (const obsolete of [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-host-apiproxy",
  ]) {
    if (
      injected.includes(obsolete) ||
      Object.hasOwn(manifest.peerDependencies ?? {}, obsolete)
    ) {
      throw new Error(
        `packed manifest still references obsolete DSH service ${obsolete}`,
      );
    }
  }

  const patch = readFileSync(join(packageDir, "cordis.patch.yml"), "utf8");
  for (const required of [
    "dsh-speech",
    "@lamplitisles/dsh-speech",
    "connection",
    "credentials",
    "settings",
    "systemPrompt",
    "sessions",
    "webServer",
  ]) {
    if (!patch.includes(required))
      throw new Error(`Cordis patch is missing ${required}`);
  }
  runtime = await startRuntime(entry, env, runtimeCwd);
  const cookie = await authenticateRuntime(runtime);
  const homePage = await fetch(new URL("/", runtime.baseUrl), {
    headers: { cookie },
  });
  if (!homePage.ok)
    throw new Error(
      `installed DSH Web runtime returned ${homePage.status} for /`,
    );
  const html = await homePage.text();
  const bootStart = html.indexOf('globalThis["__DSH_BOOT__"]');
  const bootEnd = bootStart < 0 ? -1 : html.indexOf("</script>", bootStart);
  const bootSource =
    bootStart < 0 || bootEnd < 0 ? "" : html.slice(bootStart, bootEnd);
  const jsonStart = bootSource.indexOf("{");
  const jsonEnd = bootSource.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart)
    throw new Error("DSH Web bootstrap did not expose __DSH_BOOT__");
  const boot = JSON.parse(bootSource.slice(jsonStart, jsonEnd + 1)) as {
    entries?: Array<{ id?: string; url?: string }>;
  };
  const pluginEntry = boot.entries?.find(
    (candidate) => candidate.id === manifest.name,
  );
  if (!pluginEntry?.url)
    throw new Error(
      "installed plugin is absent from the DSH Web bootstrap entries",
    );

  const clientResponse = await fetch(
    new URL(pluginEntry.url, runtime.baseUrl),
    { headers: { cookie } },
  );
  if (!clientResponse.ok)
    throw new Error(
      `installed DSH client bundle returned ${clientResponse.status}`,
    );
  const clientCode = await clientResponse.text();
  let loaded: { id?: string; factory?: unknown } | undefined;
  vm.runInNewContext(clientCode, {
    window: {
      __ModuleLoader__: {
        load(spec: { id?: string; factory?: unknown }) {
          loaded = spec;
        },
      },
    },
  });
  if (loaded?.id !== manifest.name || typeof loaded.factory !== "function") {
    throw new Error(
      "served client bundle did not register with the DSH Loader",
    );
  }

  const rpc = await jsonRequest(
    runtime.baseUrl,
    "/dsh-speech/synthesize",
    {
      type: "client-request",
      rpcId: "pack-smoke-rpc",
      method: "synthesize",
      payload: { text: "", sessionId: "session-smoke" },
    },
    cookie,
  );
  const rpcEnvelope = rpc.value as {
    type?: string;
    rpcId?: string;
    result?: { ok?: boolean; error?: { message?: string } };
  };
  if (
    !rpc.response.ok ||
    rpcEnvelope.type !== "server-response" ||
    rpcEnvelope.rpcId !== "pack-smoke-rpc" ||
    rpcEnvelope.result?.error?.message !== "invalid-input"
  ) {
    throw new Error(
      `installed host RPC did not activate: ${JSON.stringify(rpc.value)}`,
    );
  }

  const settings = await jsonRequest(
    runtime.baseUrl,
    "/api/settings/describe",
    {
      type: "client-request",
      rpcId: "pack-smoke-settings",
      method: "settings/describe",
      payload: { args: {} },
    },
    cookie,
  );
  const settingsEnvelope = settings.value as {
    type?: string;
    rpcId?: string;
    result?: {
      ok?: boolean;
      value?: {
        namespaces?: Array<{
          ns?: string;
          value?: {
            provider?: string;
            alibabaVoice?: string;
            bytedanceVoice?: string;
          };
        }>;
      };
    };
  };
  const namespace = settingsEnvelope.result?.value?.namespaces?.find(
    (candidate) => candidate.ns === "dsh-speech",
  );
  if (
    !settings.response.ok ||
    settingsEnvelope.type !== "server-response" ||
    settingsEnvelope.rpcId !== "pack-smoke-settings" ||
    settingsEnvelope.result?.ok !== true ||
    namespace?.value?.provider !== "alibaba" ||
    namespace?.value?.alibabaVoice !== "Maia" ||
    namespace?.value?.bytedanceVoice !== "zh_female_sajiaoxuemei_uranus_bigtts"
  ) {
    throw new Error(
      `installed Settings registration did not activate: ${JSON.stringify(settings.value)}`,
    );
  }

  writeFileSync(
    join(home, "smoke-result.json"),
    JSON.stringify({
      package: manifest.name,
      baseUrl: runtime.baseUrl,
      client: loaded.id,
      rpc: rpcEnvelope.result?.error?.message,
      settings: namespace.ns,
    }),
  );
  console.log(
    `pack-smoke: installed ${manifest.name}; DSH Web runtime, host RPC, Settings, and client loader verified on ${runtime.baseUrl}`,
  );
} finally {
  if (runtime) await stopRuntime(runtime.child);
  rmSync(temp, { recursive: true, force: true });
}
