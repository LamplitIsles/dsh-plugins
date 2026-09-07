import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DSH_RC_VERSION,
  authenticateRuntime,
  dshInvocation,
  isolatedEnvironment,
  jsonRequest,
  linkDshDependencies,
  loadServedClient,
  startRuntime,
  stopRuntime,
} from "../../../scripts/dsh-web-smoke.mjs";
import {
  packedArtifactPath,
  pnpmPack,
} from "../../../scripts/release-shared.js";

const root = resolve(import.meta.dirname, "..");
execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });

const configuredDsh = process.env.DSH_CLI;
if (!configuredDsh || !existsSync(configuredDsh)) {
  throw new Error(
    `pack-smoke requires DSH_CLI set to the official DSH ${DSH_RC_VERSION} executable`,
  );
}
const dsh = dshInvocation(resolve(configuredDsh));

const packDir = await mkdtemp(join(tmpdir(), "dsh-mail-pack-smoke-"));
try {
  const packed = pnpmPack(root, { destination: packDir });
  const artifact = packedArtifactPath(packed, packDir);
  const files = new Set(
    execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  );
  for (const path of [
    "package/dist/index.js",
    "package/dist/client.js",
    "package/cordis.patch.yml",
    "package/README.md",
    "package/CONTEXT.md",
  ]) {
    if (!files.has(path)) throw new Error(`packed plugin is missing ${path}`);
  }

  const patch = await readFile(resolve(root, "cordis.patch.yml"), "utf8");
  for (const required of [
    "id: dsh-mail",
    'name: "@lamplitisles/dsh-mail"',
    "webServer",
  ]) {
    if (!patch.includes(required))
      throw new Error(`Cordis patch is missing ${required}`);
  }

  // Compose and serve the packed artifact through a test-owned Web profile.
  const dshHome = join(packDir, "dsh-home");
  const runtimeCwd = join(packDir, "runtime-cwd");
  await mkdir(runtimeCwd, { recursive: true });
  const loaderEnv = isolatedEnvironment(packDir, dshHome);
  let runtime;
  try {
    const version = execFileSync(dsh.command, [...dsh.args, "--version"], {
      env: loaderEnv,
      encoding: "utf8",
    }).trim();
    if (version !== DSH_RC_VERSION) {
      throw new Error(
        `pack-smoke requires DSH ${DSH_RC_VERSION}, got ${version || "unknown"}`,
      );
    }

    await linkDshDependencies(packDir, resolve(configuredDsh), dsh);
    execFileSync(
      dsh.command,
      [
        ...dsh.args,
        "plugin",
        "--profile",
        "web",
        "add",
        artifact,
        "--ignore-scripts",
      ],
      { cwd: runtimeCwd, env: loaderEnv, stdio: "ignore" },
    );
    const composed = execFileSync(
      dsh.command,
      [...dsh.args, "--profile", "web", "--dump-config"],
      { cwd: runtimeCwd, env: loaderEnv, encoding: "utf8" },
    );
    if (
      !composed.includes("@lamplitisles/dsh-mail") ||
      !composed.includes("id: dsh-mail")
    ) {
      throw new Error(
        "DSH loader did not compose dsh-mail from the packed artifact",
      );
    }

    const installedPackage = join(
      dshHome,
      "profiles",
      "web",
      "node_modules",
      "@lamplitisles",
      "dsh-mail",
    );
    if (!existsSync(join(installedPackage, "dist", "index.js"))) {
      throw new Error("DSH did not install the packed Mail Host entry");
    }

    runtime = await startRuntime(resolve(configuredDsh), loaderEnv, runtimeCwd);
    const cookie = await authenticateRuntime(runtime);
    const servedClient = await loadServedClient(
      runtime,
      "@lamplitisles/dsh-mail",
      cookie,
    );
    if (
      !servedClient.code.includes("data-plugin-css") ||
      !servedClient.code.includes("--dsw-alias-label-primary")
    ) {
      throw new Error(
        "served Mail client bundle does not contain its semantic stylesheet",
      );
    }

    const status = await jsonRequest(
      runtime.baseUrl,
      "/dsh-mail/status",
      {
        type: "client-request",
        rpcId: "pack-smoke-mail-status",
        method: "status",
        payload: {},
      },
      cookie,
    );
    const statusEnvelope = status.value as {
      type?: string;
      rpcId?: string;
      result?: { ok?: boolean; value?: { state?: string } };
    };
    if (
      !status.response.ok ||
      statusEnvelope.type !== "server-response" ||
      statusEnvelope.rpcId !== "pack-smoke-mail-status" ||
      statusEnvelope.result?.ok !== true ||
      statusEnvelope.result.value?.state !== "idle"
    ) {
      throw new Error(
        `installed Host Mail status RPC did not activate: ${JSON.stringify(status.value)}`,
      );
    }

    const settings = await jsonRequest(
      runtime.baseUrl,
      "/api/settings/describe",
      {
        type: "client-request",
        rpcId: "pack-smoke-mail-settings",
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
        value?: { namespaces?: Array<{ ns?: string; applies?: string }> };
      };
    };
    const namespace = settingsEnvelope.result?.value?.namespaces?.find(
      (candidate) => candidate.ns === "dsh-mail",
    );
    if (
      !settings.response.ok ||
      settingsEnvelope.type !== "server-response" ||
      settingsEnvelope.rpcId !== "pack-smoke-mail-settings" ||
      settingsEnvelope.result?.ok !== true ||
      namespace?.applies !== "live"
    ) {
      throw new Error(
        `installed Mail Settings registration did not activate: ${JSON.stringify(settings.value)}`,
      );
    }

    const callback = await fetch(
      new URL("/oauth/dsh-mail/callback", runtime.baseUrl),
      {
        method: "POST",
        headers: { cookie },
      },
    );
    if (callback.status !== 405) {
      throw new Error(
        `installed Mail callback route returned ${callback.status} for POST instead of 405`,
      );
    }

    console.log(
      JSON.stringify(
        {
          package: "@lamplitisles/dsh-mail",
          client: servedClient.registration.id,
          host: true,
          loader: true,
          css: true,
          status: statusEnvelope.result?.value?.state,
          settings: namespace.ns,
          callback: callback.status,
        },
        null,
        2,
      ),
    );
  } finally {
    await stopRuntime(runtime);
  }
} finally {
  await rm(packDir, { recursive: true, force: true });
}
