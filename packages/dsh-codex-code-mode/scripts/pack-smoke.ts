import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
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
const entry = packageFor("@lamplitisles/dsh-codex-code-mode");
if (entry === undefined)
  throw new Error(
    "Codex code-mode package is missing from the public inventory",
  );

const code = `const [alpha, beta] = await Promise.all([
  tools.alpha({ value: 3 }),
  tools.beta({ value: 4 }),
]);
return { alpha, beta };`;

type ResponseBody = Record<string, any>;

function send(socket: WebSocket, value: ResponseBody): void {
  socket.send(JSON.stringify(value));
}

function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  onMessage: (child: ChildProcess, message: unknown) => void,
): Promise<void> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (message) => onMessage(child, message));
    child.once("error", rejectChild);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }
      rejectChild(
        new Error(`packed runner exited with ${code ?? signal ?? "unknown"}`),
      );
    });
  });
}

function sendCodeResponse(socket: WebSocket): void {
  const item = {
    type: "custom_tool_call",
    id: "fc-1",
    call_id: "call-1",
    name: "run_code",
    input: code,
  };
  send(socket, {
    type: "response.created",
    response: { id: "resp-1", status: "in_progress" },
  });
  send(socket, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, input: "" },
  });
  send(socket, {
    type: "response.custom_tool_call_input.delta",
    output_index: 0,
    delta: code.slice(0, 44),
  });
  send(socket, {
    type: "response.custom_tool_call_input.delta",
    output_index: 0,
    delta: code.slice(44),
  });
  send(socket, {
    type: "response.custom_tool_call_input.done",
    output_index: 0,
    input: code,
  });
  send(socket, {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  send(socket, {
    type: "response.completed",
    response: {
      id: "resp-1",
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
}

function sendContinuationResponse(socket: WebSocket): void {
  const item = {
    type: "message",
    id: "msg-2",
    role: "assistant",
    content: [{ type: "output_text", text: "continuation complete" }],
  };
  send(socket, {
    type: "response.created",
    response: { id: "resp-2", status: "in_progress" },
  });
  send(socket, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, content: [] },
  });
  send(socket, {
    type: "response.output_text.delta",
    output_index: 0,
    delta: "continuation complete",
  });
  send(socket, {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  send(socket, {
    type: "response.completed",
    response: {
      id: "resp-2",
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 18,
        output_tokens: 3,
        total_tokens: 21,
        input_tokens_details: { cached_tokens: 12 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
}

function runnerSource({
  activationUrl,
  codexBaseUrl,
  cordisUrl,
  loaderUrl,
  llmUrl,
  codexApiUrl,
  codexLazyUrl,
  sessionUrl,
  toolsUrl,
  runtimeUrl,
}: {
  activationUrl: string;
  codexBaseUrl: string;
  cordisUrl: string;
  loaderUrl: string;
  llmUrl: string;
  codexApiUrl: string;
  codexLazyUrl: string;
  sessionUrl: string;
  toolsUrl: string;
  runtimeUrl: string;
}): string {
  return `
import assert from "node:assert/strict";
import { Context } from ${JSON.stringify(cordisUrl)};
import Loader from ${JSON.stringify(loaderUrl)};
import {
  BlockAssembler,
  LlmRuntime,
  createToolResultMessage,
  createUserMessage,
} from ${JSON.stringify(llmUrl)};
import { closeOpenAICodexWebSocketSessions } from ${JSON.stringify(codexApiUrl)};
import { openAICodexResponsesApi } from ${JSON.stringify(codexLazyUrl)};
import SessionStore from ${JSON.stringify(sessionUrl)};
import { defineTool, ToolRuntime } from ${JSON.stringify(toolsUrl)};
import WorkerThreadCodeRuntime from ${JSON.stringify(runtimeUrl)};

const baseURL = ${JSON.stringify(codexBaseUrl)};
const token = "header." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "pack-smoke-account" },
})).toString("base64url") + ".signature";
let currentSettings = {
  enabled: true,
  baseURL,
  credentialRef: "CODEX_API_KEY",
  models: [{ id: "gpt-5-codex", name: "GPT-5 Codex", contextWindow: 262144, maxTokens: 32768 }],
  transport: "websocket-cached",
};
const settingsListeners = new Set();
const systemPrompt = {
  tools: () => () => undefined,
  section: () => () => undefined,
  getSectionOrder: () => 0,
};
const root = new Context();
root.provide("systemPrompt", systemPrompt);
root.provide("credentials", {
  resolve: async () => ({ value: token }),
});
root.provide("settings", {
  register(namespace, schema, options) {
    assert.equal(namespace, "dsh-codex-code-mode");
    assert.equal(options.applies, "live");
    return {
      get: () => currentSettings,
      watch: (listener) => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    };
  },
});

const llmRuntime = root.plugin(LlmRuntime);
await llmRuntime;
const toolsRuntime = root.plugin(ToolRuntime, { mode: "ptc", maxParallelSubCalls: 10 });
await toolsRuntime;
const codeRuntime = root.plugin(WorkerThreadCodeRuntime, {
  computeMs: 5000,
  maxWallMs: 10000,
  maxOutputBytes: 65536,
});
await codeRuntime;
const loader = root.plugin(Loader, { baseUrl: import.meta.url });
await loader;
const sessionsRuntime = root.plugin(SessionStore);
await sessionsRuntime;

function sendParent(message) {
  if (typeof process.send !== "function")
    throw new Error("packed smoke runner requires an IPC parent");
  process.send(message);
}

function waitForParent(type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
  });
}

let active = 0;
let maximumActive = 0;
function makeTestTool(name) {
  return defineTool({
    name,
    description: "Test-only tool used by the packed Codex PTC smoke.",
    parameters: {
      value: { type: "integer", required: true },
    },
    output: {
      schema: { type: "integer" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        exec.signal.throwIfAborted();
        return args.value * 2;
      } finally {
        active -= 1;
      }
    },
  });
}
const disposeAlpha = root.tools.register(makeTestTool("alpha"));
const disposeBeta = root.tools.register(makeTestTool("beta"));
const activationPath = ${JSON.stringify(activationUrl)};
let entryId;
let unloadDone = Promise.resolve();
let unrelatedDone = Promise.resolve();
try {
  entryId = await root.loader.create({
    id: "dsh-codex-code-mode",
    name: activationPath,
    inject: ["llm", "credentials", "settings", "sessions"],
  });
  await root.loader.await();
  assert.equal(root.llm.listProviders().some((provider) => provider.id === "codex-code-mode"), true);
  assert.deepEqual(root.tools.schemas().map((tool) => tool.name), ["alpha", "beta", "run_code"]);

  const tools = root.tools.schemas();
  const user = createUserMessage({
    content: [{ type: "text", text: "Run both test tools and continue." }],
    source: { kind: "user" },
  });
  const sessionId = "pack-codex-session";
  const firstAssembler = new BlockAssembler();
  const firstStream = root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5-codex",
    messages: [user],
    system: "Use the DSH TypeScript SDK.",
    tools,
    sessionId,
    signal: new AbortController().signal,
  });
  for await (const chunk of firstStream) {
    firstAssembler.push(chunk);
  }
  const firstBlocks = firstAssembler.blocks();
  assert.equal(firstBlocks.length, 1);
  assert.equal(firstBlocks[0].type, "tool-call");
  if (firstBlocks[0].type !== "tool-call") throw new Error("packed Codex response did not produce a tool call");
  assert.equal(firstBlocks[0].name, "run_code");
  const firstArguments = JSON.parse(firstBlocks[0].arguments);
  assert.deepEqual(Object.keys(firstArguments).sort(), ["code", "description"]);
  assert.equal(firstArguments.description, "Run code");
  assert.equal(firstArguments.code, ${JSON.stringify(code)});

  const runCode = root.tools.get("run_code");
  assert.ok(runCode);
  const execution = await root.tools.execute({
    callId: firstBlocks[0].id,
    name: "run_code",
    arguments: firstArguments,
    signal: new AbortController().signal,
  });
  assert.equal(execution.isError, false);
  if (execution.isError) throw new Error(execution.error.message);
  assert.deepEqual(execution.value, { logs: [], result: { alpha: 6, beta: 8 } });
  assert.equal(maximumActive, 2);

  const assistant = firstAssembler.message({
    kind: "model",
    provider: "codex-code-mode",
    model: "gpt-5-codex",
    ...(firstAssembler.replayState === undefined ? {} : { replayState: firstAssembler.replayState }),
  });
  const toolResult = createToolResultMessage({
    callId: firstBlocks[0].id,
    content: execution.content,
    isError: false,
  });
  const secondAssembler = new BlockAssembler();
  for await (const chunk of root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5-codex",
    messages: [user, assistant, toolResult],
    system: "Use the DSH TypeScript SDK.",
    tools,
    sessionId,
    signal: new AbortController().signal,
  })) secondAssembler.push(chunk);
  assert.deepEqual(secondAssembler.blocks(), [{ type: "text", text: "continuation complete" }]);

  let unloadSettled = false;
  const unloadStream = root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5-codex",
    messages: [user],
    system: "Use the DSH TypeScript SDK.",
    tools,
    sessionId,
    signal: new AbortController().signal,
  });
  unloadDone = (async () => {
    try {
      for await (const _chunk of unloadStream) {
        // The fake server deliberately holds the route request open.
      }
    } catch {
      // Loader disposal is expected to cancel this stream.
    } finally {
      unloadSettled = true;
    }
  })();
  sendParent({ type: "await-unload" });
  await waitForParent("unload-ready");

  const stockApi = openAICodexResponsesApi();
  const unrelatedStream = stockApi.stream(
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: baseURL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
      compat: {
        supportsOpenAIGrammarTools: true,
        supportsDeveloperRole: true,
        supportsStrictMode: true,
      },
    },
    { messages: [user] },
    {
      apiKey: token,
      transport: "websocket-cached",
      sessionId: "pack-stock-session",
      signal: new AbortController().signal,
    },
  );
  unrelatedDone = (async () => {
    try {
      for await (const _chunk of unrelatedStream) {
        // The fake server deliberately holds this unrelated route open.
      }
    } catch {
      // Final test cleanup closes the held stock-provider stream.
    }
  })();
  sendParent({ type: "await-stock" });
  await waitForParent("stock-ready");

  currentSettings = { ...currentSettings, enabled: false };
  for (const listener of settingsListeners) listener(currentSettings, { ...currentSettings, enabled: true });
  assert.equal(root.llm.listProviders().some((provider) => provider.id === "codex-code-mode"), false);
  await root.loader.remove(entryId);
  await Promise.race([
    unloadDone,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("unload did not cancel the active stream")), 5_000),
    ),
  ]);
  assert.equal(unloadSettled, true);
  sendParent({ type: "unload-probe" });
  await waitForParent("unload-probe-ack");
  console.log("codex-code-mode-loader: packed Host, fake Codex WebSocket, canonical run_code, parallel PTC, continuation, scoped unload, and opt-out passed");
} finally {
  // Final safety net only: the loader removal above is the lifecycle assertion.
  closeOpenAICodexWebSocketSessions("pack-codex-session");
  closeOpenAICodexWebSocketSessions("pack-stock-session");
  await Promise.race([
    unloadDone,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  await Promise.race([
    unrelatedDone,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (entryId !== undefined && root.llm.listProviders().some((provider) => provider.id === "codex-code-mode")) {
    await root.loader.remove(entryId);
  }
  disposeAlpha();
  disposeBeta();
  await codeRuntime.dispose();
  await toolsRuntime.dispose();
  await llmRuntime.dispose();
}
`;
}

const configuredCli = process.env.DSH_CLI;
if (configuredCli === undefined) {
  throw new Error(
    `Set DSH_CLI to the official DSH ${DSH_RC_VERSION} executable.`,
  );
}
const cli = resolve(configuredCli);
const invocation = dshInvocation(cli);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "dsh-codex-code-mode-pack-smoke-"),
);
const sockets = new Set<WebSocket>();
const requests: ResponseBody[] = [];
let serverFailure: unknown;
let unloadWaiter: ChildProcess | undefined;
let stockWaiter: ChildProcess | undefined;
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("message", (raw) => {
    try {
      const request = JSON.parse(rawText(raw)) as ResponseBody;
      assert.equal(request.type, "response.create");
      requests.push(request);
      if (requests.length === 1) sendCodeResponse(socket);
      else if (requests.length === 2) sendContinuationResponse(socket);
      else if (requests.length === 3) {
        unloadWaiter?.send({ type: "unload-ready" });
        unloadWaiter = undefined;
      } else if (requests.length === 4) {
        stockWaiter?.send({ type: "stock-ready" });
        stockWaiter = undefined;
      } else
        throw new Error(`unexpected fake Codex request ${requests.length}`);
    } catch (error) {
      serverFailure = error;
      socket.close(1011, "pack smoke failure");
    }
  });
});

async function waitForSocketCount(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (sockets.size !== expected) {
    if (serverFailure !== undefined) throw serverFailure;
    if (Date.now() >= deadline)
      throw new Error(
        `expected ${expected} fake WebSocket(s), got ${sockets.size}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("listening", () => resolveListen());
    server.once("error", rejectListen);
  });
  const address = server.address() as AddressInfo;
  const codexBaseUrl = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(checkPackedFiles(root, entry), []);
  const artifact = packRelease(root, entry, temporaryDirectory);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", artifact, "package/package.json"], {
      encoding: "utf8",
    }),
  ) as Record<string, any>;
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.equal(manifest.dependencies?.["@earendil-works/pi-ai"], "0.84.4");
  assert.equal(manifest.dependencies?.["@deepseek-ai/dsh-llm"], undefined);
  assert.equal(manifest.exports?.["./client"], undefined);

  const home = join(temporaryDirectory, "dsh-home");
  const cwd = join(temporaryDirectory, "workspace");
  await mkdir(cwd, { recursive: true });
  const env = isolatedEnvironment(temporaryDirectory, home);
  assert.equal(
    execFileSync(invocation.command, [...invocation.args, "--version"], {
      encoding: "utf8",
      env,
    }).trim(),
    DSH_RC_VERSION,
  );
  await linkDshDependencies(temporaryDirectory, cli, invocation);
  execFileSync(
    invocation.command,
    [
      ...invocation.args,
      "plugin",
      "--profile",
      "codex-smoke",
      "add",
      artifact,
      "--ignore-scripts",
    ],
    { cwd, env, stdio: "inherit" },
  );
  const dump = execFileSync(
    invocation.command,
    [...invocation.args, "--profile", "codex-smoke", "--dump-config"],
    { cwd, env, encoding: "utf8" },
  );
  assert.match(dump, /@lamplitisles\/dsh-codex-code-mode/u);
  const installed = join(
    home,
    "profiles",
    "codex-smoke",
    "node_modules",
    "@lamplitisles",
    "dsh-codex-code-mode",
  );
  const entryPath = join(installed, "dist", "index.js");
  const activationPath = join(
    temporaryDirectory,
    "activate-codex-code-mode.mjs",
  );
  await writeFile(
    activationPath,
    `import { apply, inject, name } from ${JSON.stringify(pathToFileURL(entryPath).href)};\nif (name !== "dsh-codex-code-mode" || typeof apply !== "function" || !inject.includes("llm")) throw new Error("packed Codex Host entry lost its contract");\nexport default { apply, inject, name };\n`,
  );
  const runnerPath = join(temporaryDirectory, "loader-runner.mjs");
  const resolver = createRequire(pathToFileURL(runnerPath));
  const moduleUrl = (specifier: string): string =>
    pathToFileURL(resolver.resolve(specifier)).href;
  const codexApiUrl = pathToFileURL(
    join(
      home,
      "profiles",
      "codex-smoke",
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "api",
      "openai-codex-responses.js",
    ),
  ).href;
  const codexLazyUrl = pathToFileURL(
    join(
      home,
      "profiles",
      "codex-smoke",
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "api",
      "openai-codex-responses.lazy.js",
    ),
  ).href;
  await writeFile(
    runnerPath,
    runnerSource({
      activationUrl: pathToFileURL(activationPath).href,
      codexBaseUrl,
      cordisUrl: moduleUrl("@deepseek-ai/cordis"),
      loaderUrl: moduleUrl("@deepseek-ai/cordis-plugin-loader"),
      llmUrl: moduleUrl("@deepseek-ai/dsh-llm"),
      codexApiUrl,
      codexLazyUrl,
      sessionUrl: moduleUrl("@deepseek-ai/dsh-session"),
      toolsUrl: moduleUrl("@deepseek-ai/dsh-tools"),
      runtimeUrl: moduleUrl("@deepseek-ai/dsh-code-runtime-worker-thread"),
    }),
  );
  // Keep the parent event loop active so it can service the child’s fake WebSocket.
  await runChild(
    process.execPath,
    ["--expose-internals", runnerPath],
    { cwd: temporaryDirectory, env },
    (child, message) => {
      if (typeof message !== "object" || message === null) return;
      const type = (message as { type?: unknown }).type;
      if (type === "await-unload") {
        if (requests.length >= 3) child.send({ type: "unload-ready" });
        else unloadWaiter = child;
        return;
      }
      if (type === "await-stock") {
        if (requests.length >= 4) child.send({ type: "stock-ready" });
        else stockWaiter = child;
        return;
      }
      if (type === "unload-probe") {
        void waitForSocketCount(1)
          .then(() => child.send({ type: "unload-probe-ack" }))
          .catch((error: unknown) => {
            console.error("pack smoke: unload probe failed", error);
            serverFailure = error;
            child.kill();
          });
      }
    },
  );
  if (serverFailure !== undefined) throw serverFailure;
  await waitForSocketCount(0);
  assert.equal(requests.length, 4);
  assert.ok(
    requests[0]?.tools?.some((tool: ResponseBody) => tool.name === "run_code"),
  );
  assert.equal(requests[1]?.previous_response_id, "resp-1");
  console.log(
    JSON.stringify({
      package: entry.name,
      packed: true,
      loader: true,
      websocket: true,
      ptc: true,
      continuation: true,
      unload: true,
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
