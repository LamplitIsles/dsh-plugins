import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
} from "./dsh-web-smoke.mjs";
import {
  PUBLIC_PACKAGES,
  packageDirectory,
  packedArtifactPath,
  packedManifest,
  pnpmPack,
} from "./release-shared.js";

const root = resolve(import.meta.dirname, "..");
const entry = PUBLIC_PACKAGES.find(
  ({ name }) => name === "@lamplitisles/dsh-imagegen",
)!;

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function imagegenRunnerSource({
  activationUrl,
  cordisUrl,
  loaderUrl,
  workspace,
}: {
  activationUrl: string;
  cordisUrl: string;
  loaderUrl: string;
  workspace: string;
}): string {
  return `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";
import { Context } from ${JSON.stringify(cordisUrl)};
import Loader from ${JSON.stringify(loaderUrl)};

const workspace = ${JSON.stringify(workspace)};
const encodedPng = "iVBORw0KGgoA";
const png = Uint8Array.from(Buffer.from(encodedPng, "base64"));
const requests = [];
let bridgeFailure;
const bridge = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/codex/images") {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(body);
    assert.deepEqual(payload, { prompt: "pack smoke image" });
    requests.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ image_url: "data:image/png;base64," + encodedPng }));
  } catch (error) {
    bridgeFailure = error;
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("test bridge rejected the request");
  }
});

await mkdir(workspace, { recursive: true });
await new Promise((resolveListen, rejectListen) => {
  bridge.once("error", rejectListen);
  bridge.listen(0, "127.0.0.1", resolveListen);
});
const address = bridge.address();
if (!address || typeof address === "string") throw new Error("test image bridge did not expose a port");
const bridgeUrl = "http://127.0.0.1:" + address.port;

function targetPath(cwd, path) {
  return resolvePath(cwd, path);
}
const fs = {
  resolve: async (path, options = {}) => ({ targetKey: targetPath(options.cwd ?? workspace, path) }),
  contains: (parent, child) => {
    const childRelative = relative(parent.targetKey, child.targetKey);
    return childRelative === "" || (!childRelative.startsWith("..") && !childRelative.startsWith("/"));
  },
  stat: async (target) => {
    try {
      const details = await stat(target.targetKey);
      return { type: details.isFile() ? "file" : details.isDirectory() ? "directory" : "other" };
    } catch {
      return undefined;
    }
  },
  readBytes: async (target) => new Uint8Array(await readFile(target.targetKey)),
  processPath: (target) => target.targetKey,
};
const attachments = {
  validateImage: async () => undefined,
  saveImage: async ({ data, mediaType, name }) => {
    assert.equal(mediaType, "image/png");
    return {
      attachmentId: "pack-smoke-image",
      mediaType,
      bytes: data.byteLength,
      width: 1,
      height: 1,
      name,
    };
  },
};
let settingsNamespace;
const settings = {
  register(namespace) {
    settingsNamespace = namespace;
    return { get: () => ({ bridgeUrl }) };
  },
};
const registeredTools = [];
const tools = {
  register(tool) {
    registeredTools.push(tool);
    return () => undefined;
  },
};

const root = new Context();
root.provide("attachments", attachments);
root.provide("fs", fs);
root.provide("settings", settings);
root.provide("tools", tools);
let entryId;
try {
  await root.plugin(Loader, { baseUrl: import.meta.url });
  entryId = await root.loader.create({ id: "imagegen-pack-smoke", name: ${JSON.stringify(activationUrl)} });
  await root.loader.await();
  assert.equal(settingsNamespace, "lamplitisles-kepos-imagegen");
  assert.equal(registeredTools.length, 1);
  assert.equal(registeredTools[0].name, "kepos_image_generate");

  const result = await registeredTools[0].execute(
    { prompt: "pack smoke image" },
    { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal },
  );
  if (bridgeFailure) throw bridgeFailure;
  assert.equal(requests.length, 1);
  assert.match(result.path, /^\\.dsh\\/kepos-imagegen\\/[0-9a-f-]+\\.png$/u);
  assert.deepEqual([...await readFile(resolvePath(workspace, result.path))], [...png]);
  assert.equal(result.attachment.attachmentId, "pack-smoke-image");
  assert.equal(result.attachment.mediaType, "image/png");
  console.log("imagegen-loader: packed Host activated through real Loader and generated a PNG through the test-owned HTTP bridge");
} finally {
  if (entryId !== undefined) await root.loader.remove(entryId);
  await new Promise((resolveClose, rejectClose) => bridge.close((error) => error ? rejectClose(error) : resolveClose()));
}
`;
}

const configuredCli = process.env.DSH_CLI;
requireCondition(
  configuredCli && existsSync(configuredCli),
  `Set DSH_CLI to the official DSH ${DSH_RC_VERSION} executable.`,
);
const cli = resolve(configuredCli);
const cliInvocation = dshInvocation(cli);

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "dsh-imagegen-pack-smoke-"),
);
try {
  const packagePath = packageDirectory(root, entry);
  for (const required of entry.requiredFiles) {
    requireCondition(
      existsSync(join(packagePath, required)),
      `Imagegen must be built before pack smoke (${required}).`,
    );
  }

  const packed = pnpmPack(packagePath, { destination: temporaryDirectory });
  const artifact = packedArtifactPath(packed, temporaryDirectory);
  const packedMetadata = packedManifest(packed);
  requireCondition(
    packedMetadata?.name === entry.name,
    "Imagegen packed package name is incorrect.",
  );
  const files = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const required of entry.requiredFiles) {
    requireCondition(
      files.includes(`package/${required}`),
      `Imagegen artifact omits ${required}.`,
    );
  }
  requireCondition(
    !files.some(
      (file) => file.includes("node_modules") || file.endsWith(".tgz"),
    ),
    "Imagegen artifact contains an unsafe file.",
  );
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", artifact, "package/package.json"], {
      encoding: "utf8",
    }),
  ) as Record<string, any>;
  requireCondition(
    manifest.dependencies === undefined &&
      manifest.optionalDependencies === undefined,
    "Imagegen artifact has runtime dependencies.",
  );
  for (const section of ["peerDependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith("@deepseek-ai/dsh-")) {
        requireCondition(
          version === DSH_RC_VERSION,
          `Imagegen artifact has a non-rc.1 ${section}: ${name}@${version}.`,
        );
      }
    }
  }
  const dshHome = join(temporaryDirectory, "dsh-home");
  const runtimeCwd = join(temporaryDirectory, "runtime-cwd");
  const workspace = join(temporaryDirectory, "imagegen-workspace");
  await mkdir(runtimeCwd, { recursive: true });
  const env = isolatedEnvironment(temporaryDirectory, dshHome);
  requireCondition(
    execFileSync(cliInvocation.command, [...cliInvocation.args, "--version"], {
      env,
      encoding: "utf8",
    }).trim() === DSH_RC_VERSION,
    `Expected DSH ${DSH_RC_VERSION}.`,
  );
  await linkDshDependencies(temporaryDirectory, cli, cliInvocation);
  execFileSync(
    cliInvocation.command,
    [
      ...cliInvocation.args,
      "plugin",
      "--profile",
      "web",
      "add",
      artifact,
      "--ignore-scripts",
    ],
    { cwd: runtimeCwd, env, stdio: "inherit" },
  );
  const dump = execFileSync(
    cliInvocation.command,
    [...cliInvocation.args, "--profile", "web", "--dump-config"],
    { cwd: runtimeCwd, env, encoding: "utf8" },
  );
  requireCondition(
    dump.includes("@lamplitisles/dsh-imagegen"),
    "DSH did not activate the packed Imagegen bundle.",
  );
  requireCondition(
    dump.includes("lamplitisles-kepos-imagegen"),
    "DSH did not compose the Imagegen bundle identity.",
  );

  const installed = join(
    dshHome,
    "profiles",
    "web",
    "node_modules",
    "@lamplitisles",
    "dsh-imagegen",
  );
  requireCondition(
    existsSync(join(installed, "dist", "index.js")),
    "DSH did not install the packed Imagegen Host entry.",
  );

  const runtimeRequire = createRequire(
    pathToFileURL(join(temporaryDirectory, "loader-runner.mjs")),
  );
  const activationPath = join(temporaryDirectory, "activate-imagegen.mjs");
  await writeFile(
    activationPath,
    `import { apply, inject, name } from ${JSON.stringify(pathToFileURL(join(installed, "dist/index.js")).href)};\nif (name !== "lamplitisles-kepos-imagegen" || typeof apply !== "function" || !inject.includes("attachments")) throw new Error("packed Host entry lost its Imagegen contract");\nexport default { apply, inject, name };\n`,
  );
  const runnerPath = join(temporaryDirectory, "loader-runner.mjs");
  const moduleUrl = (specifier: string): string =>
    pathToFileURL(runtimeRequire.resolve(specifier)).href;
  await writeFile(
    runnerPath,
    imagegenRunnerSource({
      activationUrl: pathToFileURL(activationPath).href,
      cordisUrl: moduleUrl("@deepseek-ai/cordis"),
      loaderUrl: moduleUrl("@deepseek-ai/cordis-plugin-loader"),
      workspace,
    }),
  );

  let runtime;
  try {
    runtime = await startRuntime(cli, env, runtimeCwd);
    const cookie = await authenticateRuntime(runtime);
    const servedClient = await loadServedClient(runtime, entry.name, cookie);
    requireCondition(
      servedClient.code.includes("data-plugin-css") &&
        servedClient.code.includes("--dsw-alias-label-primary"),
      "served Imagegen client bundle does not contain its semantic stylesheet.",
    );

    const settings = await jsonRequest(
      runtime.baseUrl,
      "/api/settings/describe",
      {
        type: "client-request",
        rpcId: "pack-smoke-imagegen-settings",
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
        value?: { namespaces?: Array<{ ns?: string }> };
      };
    };
    const namespace = settingsEnvelope.result?.value?.namespaces?.find(
      (candidate) => candidate.ns === "lamplitisles-kepos-imagegen",
    );
    requireCondition(
      settings.response.ok &&
        settingsEnvelope.type === "server-response" &&
        settingsEnvelope.rpcId === "pack-smoke-imagegen-settings" &&
        settingsEnvelope.result?.ok === true &&
        namespace !== undefined,
      `installed Imagegen Settings registration did not activate: ${JSON.stringify(settings.value)}`,
    );

    execFileSync(process.execPath, ["--expose-internals", runnerPath], {
      cwd: temporaryDirectory,
      env,
      stdio: "inherit",
    });
    console.log(
      JSON.stringify(
        {
          package: entry.name,
          client: servedClient.registration.id,
          host: true,
          loader: true,
          css: true,
          settings: namespace.ns,
          bridge: "test-owned-http",
        },
        null,
        2,
      ),
    );
  } finally {
    await stopRuntime(runtime);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
