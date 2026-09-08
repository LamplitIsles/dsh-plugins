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

const patch = `*** Begin Patch
*** Add File: added.txt
+created by apply_patch
*** Update File: existing.txt
@@
-before
+updated by apply_patch
*** End Patch`;

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

function sendPatchResponse(socket: WebSocket): void {
  const item = {
    type: "custom_tool_call",
    id: "fc-patch",
    call_id: "call-patch",
    name: "apply_patch",
    input: patch,
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
    delta: patch.slice(0, 37),
  });
  send(socket, {
    type: "response.custom_tool_call_input.delta",
    output_index: 0,
    delta: patch.slice(37),
  });
  send(socket, {
    type: "response.custom_tool_call_input.done",
    output_index: 0,
    input: patch,
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

function sendCodeResponse(socket: WebSocket): void {
  const item = {
    type: "custom_tool_call",
    id: "fc-code",
    call_id: "call-code",
    name: "run_code",
    input: code,
  };
  send(socket, {
    type: "response.created",
    response: { id: "resp-2", status: "in_progress" },
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
      id: "resp-2",
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
    response: { id: "resp-3", status: "in_progress" },
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
      id: "resp-3",
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
  fsLocalUrl,
  fsObservationUrl,
  attachmentLocalUrl,
  patchText,
  workspacePath,
  loaderUrl,
  llmUrl,
  agentUrl,
  agentLoopUrl,
  sessionProjectionUrl,
  systemPromptUrl,
  codexApiUrl,
  codexLazyUrl,
  sessionUrl,
  toolsUrl,
  runtimeUrl,
  scopeUrl,
}: {
  activationUrl: string;
  codexBaseUrl: string;
  cordisUrl: string;
  fsLocalUrl: string;
  fsObservationUrl: string;
  attachmentLocalUrl: string;
  patchText: string;
  workspacePath: string;
  loaderUrl: string;
  llmUrl: string;
  agentUrl: string;
  agentLoopUrl: string;
  sessionProjectionUrl: string;
  systemPromptUrl: string;
  codexApiUrl: string;
  codexLazyUrl: string;
  sessionUrl: string;
  toolsUrl: string;
  runtimeUrl: string;
  scopeUrl: string;
}): string {
  return `
import assert from "node:assert/strict";
import { Context } from ${JSON.stringify(cordisUrl)};
import Loader from ${JSON.stringify(loaderUrl)};
import LocalFileSystem from ${JSON.stringify(fsLocalUrl)};
import LocalAttachmentStore from ${JSON.stringify(attachmentLocalUrl)};
import { apply as applyFsObservationPolicy, name as fsObservationPolicyName } from ${JSON.stringify(fsObservationUrl)};
import {
  BlockAssembler,
  LlmAdapter,
  LlmRuntime,
  createToolResultMessage,
  createUserMessage,
} from ${JSON.stringify(llmUrl)};
import AgentRegistry, { installModelSelection } from ${JSON.stringify(agentUrl)};
import AgentLoop from ${JSON.stringify(agentLoopUrl)};
import SessionProjectionRegistry from ${JSON.stringify(sessionProjectionUrl)};
import SystemPrompt from ${JSON.stringify(systemPromptUrl)};
import { closeOpenAICodexWebSocketSessions } from ${JSON.stringify(codexApiUrl)};
import { openAICodexResponsesApi } from ${JSON.stringify(codexLazyUrl)};
import SessionStore, { SessionId } from ${JSON.stringify(sessionUrl)};
import { defineTool, ToolRuntime } from ${JSON.stringify(toolsUrl)};
import WorkerThreadCodeRuntime from ${JSON.stringify(runtimeUrl)};
import { scopeTarget } from ${JSON.stringify(scopeUrl)};

const baseURL = ${JSON.stringify(codexBaseUrl)};
const rawPatch = ${JSON.stringify(patchText)};
const workspacePath = ${JSON.stringify(workspacePath)};
const token = "header." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "pack-smoke-account" },
})).toString("base64url") + ".signature";
let currentSettings = {
  enabled: true,
  baseURL,
  credentialRef: "CODEX_API_KEY",
  models: [{ id: "gpt-5.6-sol", name: "Sol", contextWindow: 262144, maxTokens: 32768 }],
  transport: "websocket-cached",
  maxPatchChars: 4000000,
  maxPatchFiles: 64,
  maxPatchFileBytes: 4000000,
};
const settingsListeners = new Set();
const root = new Context();
const fsRuntime = root.plugin(LocalFileSystem, { cwd: workspacePath });
await fsRuntime;
const fsObservationRuntime = root.plugin({
  name: fsObservationPolicyName,
  apply: applyFsObservationPolicy,
});
await fsObservationRuntime;
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
  installSection() {
    return () => undefined;
  },
});

const llmRuntime = root.plugin(LlmRuntime);
await llmRuntime;
const projectionRuntime = root.plugin(SessionProjectionRegistry);
await projectionRuntime;
const systemPromptRuntime = root.plugin(SystemPrompt);
await systemPromptRuntime;
const toolsRuntime = root.plugin(ToolRuntime, { mode: "both", maxParallelSubCalls: 10 });
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
const agentsRuntime = root.plugin(AgentRegistry);
await agentsRuntime;
const agentLoopRuntime = root.plugin(AgentLoop, { agents: [] });
await agentLoopRuntime;

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
function makeReadTool() {
  return defineTool({
    name: "read",
    description: "Test-only read used to establish a DSH filesystem observation.",
    parameters: {
      path: { type: "string", required: true },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const target = await root.fs.resolve(args.path, {
        cwd: workspacePath,
        signal: exec.signal,
      });
      const info = await root.fs.stat(target, exec.signal);
      if (info === undefined || info.type !== "file")
        throw new Error("read target is not a regular file: " + args.path);
      const content = await root.fs.readText(target, exec.signal);
      root.emit(
        scopeTarget(root.fs, exec.agent),
        "fs/observed",
        target,
        { kind: "present", version: info.version },
        exec,
      );
      return content;
    },
  });
}
const disposeAlpha = root.tools.register(makeTestTool("alpha"));
const disposeBeta = root.tools.register(makeTestTool("beta"));
const disposeRead = root.tools.register(makeReadTool());
const stockRequests = [];
function textResponse(text) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (character) => ({ type: "text-delta", index: 0, text: character })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}
class StockAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(options) {
    stockRequests.push(options);
    for (const chunk of textResponse("stock provider complete")) yield chunk;
  }
}
const disposeStock = root.llm.registerAdapter(["stock-provider"], new StockAdapter());
const activationPath = ${JSON.stringify(activationUrl)};
let entryId;
let unloadDone = Promise.resolve();
let unrelatedDone = Promise.resolve();
let agentHandle;
let attachmentRuntime;
try {
  entryId = await root.loader.create({
    id: "dsh-codex-code-mode",
    name: activationPath,
    inject: ["llm", "credentials", "fs", "settings", "systemPrompt", "tools", "sessions"],
  });
  await root.loader.await();
  assert.equal(root.llm.listProviders().some((provider) => provider.id === "codex-code-mode"), true);
  const tools = root.tools.schemas();
  assert.deepEqual(tools.map((tool) => tool.name), ["alpha", "beta", "read", "apply_patch", "run_code"]);
  assert.deepEqual((await root.llm.listModels("codex-code-mode"))[0].inputModalities, ["text", "image"]);
  // Mount after the provider so each request must resolve the current store.
  attachmentRuntime = root.plugin(LocalAttachmentStore, { dshHome: workspacePath + "/attachment-home" });
  await attachmentRuntime;
  const attachment = await root.attachments.saveImage({
    data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC", "base64"),
    mediaType: "image/png",
    name: "pixel.png",
  });
  const user = createUserMessage({
    content: [
      { type: "text", text: "Inspect the image, apply the patch, run both test tools, and continue." },
      { type: "image", attachment },
    ],
    source: { kind: "user" },
  });
  const sessionId = "pack-codex-session";
  const selection = {
    current: { provider: "codex-code-mode", model: "gpt-5.6-sol" },
    assembled: undefined,
  };
  let switchedDuringStep = false;
  root.on("agent/request", async (_payload, next) => {
    const proposed = await next();
    if (!switchedDuringStep && proposed.provider === "codex-code-mode") {
      switchedDuringStep = true;
      queueMicrotask(() => {
        selection.current = { provider: "stock-provider", model: "stock-model" };
      });
    }
    return proposed;
  });
  agentHandle = await root.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd: workspacePath },
    agentOptions: { provider: "codex-code-mode", model: "gpt-5.6-sol" },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, selection);
    },
  });
  const agent = agentHandle.agent;
  const readResult = await root.tools.execute({
    callId: "read-before-patch",
    name: "read",
    arguments: { path: "existing.txt" },
    agent: { options: { provider: "other-provider" }, session: agent.session },
    signal: new AbortController().signal,
  });
  assert.equal(readResult.isError, false);
  if (readResult.isError) throw new Error(readResult.error.message);
  assert.equal(readResult.value, ${JSON.stringify("before\n")});
  const policyAgent = {
    options: { provider: "codex-code-mode" },
    session: { header: { cwd: workspacePath } },
  };
  const unobservedPolicyResult = await root.tools.execute({
    callId: "policy-unobserved-update",
    name: "apply_patch",
    arguments: {
      patch: ${JSON.stringify("*** Begin Patch\n*** Add File: unobserved-added.txt\n++must not publish\n*** Update File: unobserved.txt\n@@\n-before\n+after\n*** End Patch")},
    },
    agent: policyAgent,
    signal: new AbortController().signal,
  });
  assert.equal(unobservedPolicyResult.isError, true);
  assert.match(unobservedPolicyResult.error.message, /read.*first/iu);
  const unobservedAddedTarget = await root.fs.resolve("unobserved-added.txt", { cwd: workspacePath });
  const unobservedTarget = await root.fs.resolve("unobserved.txt", { cwd: workspacePath });
  assert.equal(await root.fs.stat(unobservedAddedTarget), undefined);
  assert.equal(await root.fs.readText(unobservedTarget), ${JSON.stringify("before\n")});
  const staleReadResult = await root.tools.execute({
    callId: "policy-stale-read",
    name: "read",
    arguments: { path: "stale.txt" },
    agent: { options: { provider: "other-provider" }, session: policyAgent.session },
    signal: new AbortController().signal,
  });
  assert.equal(staleReadResult.isError, false);
  if (staleReadResult.isError) throw new Error(staleReadResult.error.message);
  const staleTarget = await root.fs.resolve("stale.txt", { cwd: workspacePath });
  await root.fs.writeText(staleTarget, ${JSON.stringify("changed externally\n")});
  const stalePolicyResult = await root.tools.execute({
    callId: "policy-stale-update",
    name: "apply_patch",
    arguments: {
      patch: ${JSON.stringify("*** Begin Patch\n*** Add File: stale-added.txt\n++must not publish\n*** Update File: stale.txt\n@@\n-before\n+after\n*** End Patch")},
    },
    agent: policyAgent,
    signal: new AbortController().signal,
  });
  assert.equal(stalePolicyResult.isError, true);
  assert.match(stalePolicyResult.error.message, /stale|changed/iu);
  const staleAddedTarget = await root.fs.resolve("stale-added.txt", { cwd: workspacePath });
  assert.equal(await root.fs.stat(staleAddedTarget), undefined);
  assert.equal(await root.fs.readText(staleTarget), ${JSON.stringify("changed externally\n")});
  agent.followup(user);
  await agent.whenIdle();
  assert.equal(switchedDuringStep, true);
  assert.deepEqual(selection.assembled, {
    provider: "stock-provider",
    model: "stock-model",
  });
  assert.equal(stockRequests.length, 1);
  assert.equal(stockRequests[0]?.provider, "stock-provider");
  assert.deepEqual(
    stockRequests[0]?.tools?.map((tool) => tool.name),
    ["alpha", "beta", "read", "run_code"],
  );
  assert.doesNotMatch(stockRequests[0]?.system ?? "", /apply_patch/iu);
  sendParent({
    type: "agent-probe",
    provider: stockRequests[0]?.provider,
    tools: stockRequests[0]?.tools?.map((tool) => tool.name),
    system: stockRequests[0]?.system,
  });
  await waitForParent("agent-probe-ack");
  const addedTarget = await root.fs.resolve("added.txt", { cwd: workspacePath });
  const existingTarget = await root.fs.resolve("existing.txt", { cwd: workspacePath });
  assert.equal(await root.fs.readText(addedTarget), ${JSON.stringify("created by apply_patch\n")});
  assert.equal(await root.fs.readText(existingTarget), ${JSON.stringify("updated by apply_patch\n")});
  const secondAssembler = new BlockAssembler();
  for await (const chunk of root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5.6-sol",
    messages: [user],
    system: "Use the direct patch tool, then the DSH TypeScript SDK.",
    tools,
    sessionId,
    signal: new AbortController().signal,
  })) secondAssembler.push(chunk);
  const secondBlocks = secondAssembler.blocks();
  assert.equal(secondBlocks.length, 1);
  assert.equal(secondBlocks[0].type, "tool-call");
  if (secondBlocks[0].type !== "tool-call") throw new Error("packed continuation did not produce a tool call");
  assert.equal(secondBlocks[0].name, "run_code");
  const secondArguments = JSON.parse(secondBlocks[0].arguments);
  assert.deepEqual(Object.keys(secondArguments).sort(), ["code", "description"]);
  assert.equal(secondArguments.description, "Run code");
  assert.equal(secondArguments.code, ${JSON.stringify(code)});

  const codeExecution = await root.tools.execute({
    callId: secondBlocks[0].id,
    name: "run_code",
    arguments: secondArguments,
    agent,
    signal: new AbortController().signal,
  });
  assert.equal(codeExecution.isError, false);
  if (codeExecution.isError) throw new Error(codeExecution.error.message);
  assert.deepEqual(codeExecution.value, { logs: [], result: { alpha: 6, beta: 8 } });
  assert.equal(maximumActive, 2);

  const codeAssistant = secondAssembler.message({
    kind: "model",
    provider: "codex-code-mode",
    model: "gpt-5.6-sol",
    ...(secondAssembler.replayState === undefined ? {} : { replayState: secondAssembler.replayState }),
  });
  const codeResult = createToolResultMessage({
    callId: secondBlocks[0].id,
    content: codeExecution.content,
    isError: false,
  });
  const thirdAssembler = new BlockAssembler();
  for await (const chunk of root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5.6-sol",
    messages: [user, codeAssistant, codeResult],
    system: "Use the direct patch tool, then the DSH TypeScript SDK.",
    tools,
    sessionId,
    signal: new AbortController().signal,
  })) thirdAssembler.push(chunk);
  assert.deepEqual(thirdAssembler.blocks(), [{ type: "text", text: "continuation complete" }]);

  let unloadSettled = false;
  const unloadStream = root.llm.stream({
    provider: "codex-code-mode",
    model: "gpt-5.6-sol",
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
      id: "gpt-5.6-sol",
      name: "Sol",
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
    { messages: [{ role: "user", content: "Hold this unrelated stream open.", timestamp: 0 }] },
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
  await agentHandle?.dispose();
  await attachmentRuntime?.dispose();
  disposeStock();
  disposeAlpha();
  disposeBeta();
  disposeRead();
  await codeRuntime.dispose();
  await toolsRuntime.dispose();
  await systemPromptRuntime.dispose();
  await projectionRuntime.dispose();
  await agentLoopRuntime.dispose();
  await agentsRuntime.dispose();
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
      if (requests.length === 1) sendPatchResponse(socket);
      else if (requests.length === 2) sendCodeResponse(socket);
      else if (requests.length === 3) sendContinuationResponse(socket);
      else if (requests.length === 4) {
        unloadWaiter?.send({ type: "unload-ready" });
        unloadWaiter = undefined;
      } else if (requests.length === 5) {
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
  await writeFile(join(cwd, "existing.txt"), "before\n");
  await writeFile(join(cwd, "unobserved.txt"), "before\n");
  await writeFile(join(cwd, "stale.txt"), "before\n");
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
      fsLocalUrl: moduleUrl("@deepseek-ai/dsh-fs-local"),
      fsObservationUrl: moduleUrl("@deepseek-ai/dsh-fs-observation-policy"),
      attachmentLocalUrl: moduleUrl("@deepseek-ai/dsh-attachment-local"),
      patchText: patch,
      workspacePath: cwd,
      loaderUrl: moduleUrl("@deepseek-ai/cordis-plugin-loader"),
      llmUrl: moduleUrl("@deepseek-ai/dsh-llm"),
      agentUrl: moduleUrl("@deepseek-ai/dsh-agent"),
      agentLoopUrl: moduleUrl("@deepseek-ai/dsh-agent-loop"),
      sessionProjectionUrl: moduleUrl("@deepseek-ai/dsh-session-projection"),
      systemPromptUrl: moduleUrl("@deepseek-ai/dsh-system-prompt"),
      codexApiUrl,
      codexLazyUrl,
      sessionUrl: moduleUrl("@deepseek-ai/dsh-session"),
      toolsUrl: moduleUrl("@deepseek-ai/dsh-tools"),
      runtimeUrl: moduleUrl("@deepseek-ai/dsh-code-runtime-worker-thread"),
      scopeUrl: moduleUrl("@deepseek-ai/dsh-scope"),
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
      if (type === "agent-probe") {
        const probe = message as {
          provider?: unknown;
          tools?: unknown;
          system?: unknown;
        };
        try {
          assert.equal(probe.provider, "stock-provider");
          assert.deepEqual(probe.tools, ["alpha", "beta", "read", "run_code"]);
          assert.doesNotMatch(
            typeof probe.system === "string" ? probe.system : "",
            /apply_patch/iu,
          );
          child.send({ type: "agent-probe-ack" });
        } catch (error) {
          serverFailure = error;
          child.kill();
        }
        return;
      }
      if (type === "await-unload") {
        if (requests.length >= 4) child.send({ type: "unload-ready" });
        else unloadWaiter = child;
        return;
      }
      if (type === "await-stock") {
        if (requests.length >= 5) child.send({ type: "stock-ready" });
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
  assert.equal(requests.length, 5);
  const imageContent = requests[0]?.input
    ?.filter((item: ResponseBody) => item.role === "user")
    .flatMap((item: ResponseBody) => item.content);
  const wireImage = imageContent?.find(
    (item: ResponseBody) => item.type === "input_image",
  );
  assert.match(
    wireImage?.image_url ?? "",
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u,
  );
  assert.ok(
    imageContent?.some(
      (item: ResponseBody) =>
        item.type === "input_text" &&
        item.text.includes("Normalized copy (read-only;"),
    ),
  );
  assert.deepEqual(
    requests[0]?.tools?.map((tool: ResponseBody) => tool.name),
    ["run_code", "apply_patch"],
  );
  assert.equal(
    requests[0]?.tools?.find(
      (tool: ResponseBody) => tool.name === "apply_patch",
    )?.type,
    "custom",
  );
  assert.equal(requests[2]?.previous_response_id, "resp-2");
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
