import { existsSync, realpathSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

export const DSH_RC_VERSION = "0.1.2-rc.1";

/**
 * Resolve the official DSH shim to a direct Node invocation when possible.
 * The shim is a shell script in pnpm installations, while the package entry
 * is also a supported value for DSH_CLI in local verification environments.
 */
export function dshInvocation(entry) {
  const directEntry = resolve(entry);
  const packageEntrySuffix = join("@deepseek-ai", "dsh", "lib", "bin.js");
  const candidate = directEntry.endsWith(packageEntrySuffix)
    ? directEntry
    : resolve(dirname(directEntry), "..", packageEntrySuffix);
  if (existsSync(candidate)) {
    return {
      command: process.execPath,
      args: ["--expose-internals", candidate],
    };
  }
  return { command: entry, args: [] };
}

/**
 * Keep all DSH state and inherited environment inputs inside the test-owned
 * temporary directory. In particular, do not pass user credentials or the
 * operator's live DSH_HOME to the child process.
 */
export function isolatedEnvironment(temp, dshHome) {
  const inherited = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  const home = join(temp, "home");
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
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

/**
 * The DSH profile manager extracts a plugin without its peer graph. Link the
 * official CLI's resolved dependency tree into the disposable parent so the
 * packed plugin resolves exactly against the installed rc.1 contract.
 */
export async function linkDshDependencies(
  directory,
  entry,
  invocation = dshInvocation(entry),
) {
  const resolvedEntry = invocation.args.at(-1) ?? entry;
  const directEntry = resolve(entry);
  let runtimeNodeModules;
  if (directEntry.endsWith(join("node_modules", ".bin", "dsh"))) {
    runtimeNodeModules = dirname(dirname(directEntry));
  } else {
    let cursor = dirname(realpathSync(resolvedEntry));
    for (let depth = 0; depth < 12; depth += 1) {
      if (existsSync(join(cursor, ".pnpm", "node_modules"))) {
        runtimeNodeModules = cursor;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (!runtimeNodeModules)
    throw new Error("could not locate the official DSH runtime node_modules");
  const dependencies = join(runtimeNodeModules, ".pnpm", "node_modules");
  if (!existsSync(join(dependencies, "@deepseek-ai", "dsh-tools"))) {
    throw new Error("DSH runtime dependencies are not available");
  }
  await symlink(dependencies, join(directory, "node_modules"), "dir");
}

/** @typedef {{ child: import("node:child_process").ChildProcess; baseUrl: string; launchUrl: string }} RuntimeProcess */

/**
 * Start a cold DSH Web process on an ephemeral loopback port.
 * @returns {Promise<RuntimeProcess>}
 */
export async function startRuntime(entry, env, cwd) {
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
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let settled = false;
  let timer;
  return new Promise((resolveRuntime, rejectRuntime) => {
    const finish = (error, launchUrl) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectRuntime(error);
      else if (launchUrl)
        resolveRuntime({
          child,
          baseUrl: new URL(launchUrl).origin,
          launchUrl,
        });
      else
        rejectRuntime(
          new Error(`DSH Web runtime exited without a URL: ${output}`),
        );
    };
    const readOutput = (chunk) => {
      output += chunk.toString();
      const match = output.match(
        /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+(?:\/\?token=[^\s\r\n]+)?)/u,
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = new Error(
        `timed out waiting for DSH Web runtime: ${output}`,
      );
      void stopRuntime({ child }).then(() => rejectRuntime(error));
    }, 30_000);
  });
}

/** Stop a test-owned DSH Web child and leave no serving process behind. */
export async function stopRuntime(runtime) {
  const child = runtime?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
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

/** Exchange the one-time launch URL for a disposable browser-session cookie. */
export async function authenticateRuntime(runtime) {
  const response = await fetch(runtime.launchUrl, { redirect: "manual" });
  if (response.status !== 303) {
    throw new Error(
      `DSH Web launch URL returned ${response.status} instead of a browser-auth redirect`,
    );
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie)
    throw new Error("DSH Web launch URL did not issue a browser-auth cookie");
  return cookie;
}

/**
 * Load a plugin's client exactly as the served Web bootstrap does: fetch the
 * current entry, execute the classic script, and capture its Loader hand-off.
 */
export async function loadServedClient(runtime, packageId, cookie) {
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
  const boot = JSON.parse(bootSource.slice(jsonStart, jsonEnd + 1));
  const pluginEntry = boot.entries?.find(
    (candidate) => candidate.id === packageId,
  );
  if (!pluginEntry?.url)
    throw new Error(
      `installed plugin ${packageId} is absent from the DSH Web bootstrap entries`,
    );
  const clientResponse = await fetch(
    new URL(pluginEntry.url, runtime.baseUrl),
    { headers: { cookie } },
  );
  if (!clientResponse.ok)
    throw new Error(
      `installed DSH client bundle returned ${clientResponse.status}`,
    );
  const code = await clientResponse.text();
  let registration;
  runInNewContext(code, {
    window: {
      __ModuleLoader__: {
        load(spec) {
          registration = spec;
        },
      },
    },
  });
  if (
    registration?.id !== packageId ||
    typeof registration.factory !== "function"
  ) {
    throw new Error(
      `served ${packageId} client did not register with the DSH Loader`,
    );
  }
  return { code, registration, entry: pluginEntry };
}

/** Make one authenticated JSON RPC request through the real Web connection route. */
export async function jsonRequest(baseUrl, path, body, cookie) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `DSH returned non-JSON from ${path}: ${text.slice(0, 200)}`,
    );
  }
  return { response, value };
}
