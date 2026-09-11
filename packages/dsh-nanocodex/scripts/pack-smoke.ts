import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { type AddressInfo, type Socket } from "node:net";
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
const engineEntry = packageFor("@lamplitisles/dsh-nanocodex");
const tabletopEntry = packageFor("@lamplitisles/dsh-tabletop");
const companionEntry = packageFor("@lamplitisles/dsh-companion");
if (
  engineEntry === undefined ||
  tabletopEntry === undefined ||
  companionEntry === undefined
) {
  throw new Error(
    "Nanocodex pack smoke requires engine, tabletop, and Companion package entries",
  );
}

const configuredCli = process.env.DSH_CLI;
if (configuredCli === undefined || !existsSync(configuredCli)) {
  throw new Error(
    `Set DSH_CLI to the official DSH ${DSH_RC_VERSION} executable`,
  );
}
const NANOCODEX_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const rawPatch =
  "*** Begin Patch\n*** Add File: raw-apply-patch.txt\n+created by raw apply_patch\n*** End Patch\n";

type JsonObject = Record<string, any>;

function completedResponse(
  id: string,
  output: JsonObject[],
  totalTokens = 24,
  cachedTokens = 0,
): JsonObject {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: {
        input_tokens: Math.max(0, totalTokens - 6),
        input_tokens_details: {
          cached_tokens: cachedTokens,
          cache_write_tokens: 0,
        },
        output_tokens: 6,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: totalTokens,
      },
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sendSse(
  response: ServerResponse,
  event: JsonObject,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-request-id": "fixture-request",
    "x-codex-turn-state": "fixture-turn-state",
  });
  const bytes = Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  for (let offset = 0; offset < bytes.length; offset += 5) {
    response.write(bytes.subarray(offset, offset + 5));
    await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
  }
  response.end("data: [DONE]\n\n");
}

function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
    });
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

function runnerSource({
  activationUrl,
  tabletopActivationUrl,
  cordisUrl,
  fsLocalUrl,
  fsObservationUrl,
  loaderUrl,
  agentUrl,
  sessionUrl,
  tokenMeterUrl,
  tokenMeterClientUrl,
  sessionProjectionUrl,
  systemPromptUrl,
  toolsUrl,
  llmUrl,
  sessionControllerUrl,
  persistenceJsonlUrl,
  commandsUrl,
  commandCompactActivationUrl,
  persistenceRoot,
  storageUrl,
  storageJsonUrl,
  storageDomainUrl,
  workspaceA,
  workspaceB,
  baseUrl,
  apiBaseUrl,
}: {
  activationUrl: string;
  tabletopActivationUrl: string;
  cordisUrl: string;
  fsLocalUrl: string;
  fsObservationUrl: string;
  loaderUrl: string;
  agentUrl: string;
  sessionUrl: string;
  tokenMeterUrl: string;
  tokenMeterClientUrl: string;
  sessionProjectionUrl: string;
  systemPromptUrl: string;
  toolsUrl: string;
  llmUrl: string;
  sessionControllerUrl: string;
  persistenceJsonlUrl: string;
  commandsUrl: string;
  commandCompactActivationUrl: string;
  persistenceRoot: string;
  storageUrl: string;
  storageJsonUrl: string;
  storageDomainUrl: string;
  workspaceA: string;
  workspaceB: string;
  baseUrl: string;
  apiBaseUrl: string;
}): string {
  return `
import assert from "node:assert/strict";
import { Context } from ${JSON.stringify(cordisUrl)};
import Loader from ${JSON.stringify(loaderUrl)};
import LocalFileSystem from ${JSON.stringify(fsLocalUrl)};
import { apply as applyFsObservationPolicy, name as fsObservationPolicyName } from ${JSON.stringify(fsObservationUrl)};
import AgentRegistry, { assembleContextFor, installModelSelection } from ${JSON.stringify(agentUrl)};
import SessionStore, { SessionId, SessionPreparation } from ${JSON.stringify(sessionUrl)};
import TokenMeter from ${JSON.stringify(tokenMeterUrl)};
import { deriveTurnTokenUsage } from ${JSON.stringify(tokenMeterClientUrl)};
import SessionProjectionRegistry from ${JSON.stringify(sessionProjectionUrl)};
import SystemPrompt, { renderPrompt } from ${JSON.stringify(systemPromptUrl)};
import ToolRuntime from ${JSON.stringify(toolsUrl)};
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from ${JSON.stringify(llmUrl)};
import { buildModelCatalog } from ${JSON.stringify(sessionControllerUrl)};
import JsonlSessionPersistence from ${JSON.stringify(persistenceJsonlUrl)};
import CommandRuntime from ${JSON.stringify(commandsUrl)};
import Storage from ${JSON.stringify(storageUrl)};
import { JsonStorageBackend } from ${JSON.stringify(storageJsonUrl)};
import { DomainFacility } from ${JSON.stringify(storageDomainUrl)};

const websocketUrl = ${JSON.stringify(baseUrl)};
const workspaceA = ${JSON.stringify(workspaceA)};
const workspaceB = ${JSON.stringify(workspaceB)};
const rawPatch = "*** Begin Patch\\n*** Add File: raw-apply-patch.txt\\n+created by raw apply_patch\\n*** End Patch\\n";
const normalizedSessionId = "baf851a1-8ae5-4672-82f9-fe25968781d2";
const nativeSettingsValue = {
  providers: {
    openai: {
      apiKeyEnv: "PACK_SMOKE_API_KEY",
      baseURL: ${JSON.stringify(apiBaseUrl)},
      websocketURL: websocketUrl,
      reasoning: "low",
    },
  },
};
let settingsValue = nativeSettingsValue;
async function createHost() {
  let registeredSettings;
  const root = new Context();
  const storage = root.plugin(Storage);
  await storage;
  const backend = new JsonStorageBackend(${JSON.stringify(persistenceRoot)} + "-checkpoints");
  const unregisterBackend = root.storage.backend.register("checkpoint-fixture", backend);
  const domainFacility = new DomainFacility(root, { backend: "checkpoint-fixture" });
  root.provide("storageDomain", domainFacility);
  const fsHandle = root.plugin(LocalFileSystem, { cwd: workspaceA });
  await fsHandle;
  const fsObservationHandle = root.plugin({
    name: fsObservationPolicyName,
    apply: applyFsObservationPolicy,
  });
  await fsObservationHandle;
  root.provide("credentials", {
    resolve: async (ref) => {
      assert.equal(ref, "PACK_SMOKE_API_KEY");
      return { value: "pack-smoke-key" };
    },
  });
  root.provide("settings", {
    get(namespace) {
      assert.equal(namespace, "llm-pi-ai");
      return settingsValue;
    },
    register(namespace, schema, options) {
      assert.equal(namespace, "llm-pi-ai");
      assert.equal(options.applies, "live");
      registeredSettings = schema;
      settingsValue = schema(nativeSettingsValue);
      return { get: () => settingsValue, watch: () => () => undefined };
    },
  });
  root.provide("attachments", {
    readImage: async () => {
      throw new Error("pack smoke did not expect an image attachment");
    },
  });

  const systemPrompt = root.plugin(SystemPrompt, {
    persona: "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
  });
  await systemPrompt;
  const llmPlugin = root.plugin(LlmRuntime);
  await llmPlugin;
  const tools = root.plugin(ToolRuntime, { mode: "native" });
  await tools;
  const sessions = root.plugin(SessionStore);
  await sessions;
  const projections = root.plugin(SessionProjectionRegistry);
  await projections;
  const tokenMeter = root.plugin(TokenMeter);
  await tokenMeter;
  const persistence = root.plugin(JsonlSessionPersistence, {
    root: ${JSON.stringify(persistenceRoot)},
    compression: "none",
    packChunks: false,
    writeBatchMaxDelayMs: 1,
  });
  await persistence;
  const agents = root.plugin(AgentRegistry);
  await agents;
  const commands = root.plugin(CommandRuntime);
  await commands;
  const loader = root.plugin(Loader, { baseUrl: import.meta.url });
  await loader;

  let tabletopId;
  let engineId;
  let commandCompactId;
try {
  tabletopId = await root.loader.create({
    id: "dsh-tabletop",
    name: ${JSON.stringify(tabletopActivationUrl)},
    inject: ["tools"],
  });
  engineId = await root.loader.create({
    id: "dsh-nanocodex",
    name: ${JSON.stringify(activationUrl)},
    inject: ["agents", "sessions", "settings", "credentials", "attachments", "systemPrompt", "tools", "fs", "llm", "storageDomain"],
  });
  commandCompactId = await root.loader.create({
    id: "dsh-command-compact",
    name: ${JSON.stringify(commandCompactActivationUrl)},
    inject: ["commands", "compaction"],
  });
  await root.loader.await();
  assert.equal(typeof registeredSettings, "function");
  assert.equal(settingsValue.providers.openai.api, undefined);
  assert.deepEqual(root.tools.schemas().map((tool) => tool.name), ["roll_dice", "apply_patch"]);
const catalog = await buildModelCatalog(root, {
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(catalog.routableProviders, ["openai"]);
  assert.deepEqual(catalog.groups[0]?.models.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
  ]);
  assert.equal(catalog.groups[0]?.models[0]?.reasoning?.efforts.length, 7);
const selected = await root.llm.resolveCallConfig({
    provider: "openai",
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
  });
assert.equal(selected.model, "gpt-5.6-terra");

  return {
    root,
    persistence: root.sessionPersistence,
    sessions: root.sessions,
    agents: root.agents,
    loader: root.loader,
    systemPrompt: root.systemPrompt,
    llmPlugin: root.llm,
    tools: root.tools,
    loaderHandle: loader,
    async closeStorage() {
      await domainFacility.closeAll();
      unregisterBackend();
      await backend.close();
      await storage.dispose();
    },
    agentsHandle: agents,
    persistenceHandle: persistence,
    sessionsHandle: sessions,
    projectionsHandle: projections,
    tokenMeterHandle: tokenMeter,
    toolsHandle: tools,
    fsHandle,
    fsObservationHandle,
    llmHandle: llmPlugin,
    systemPromptHandle: systemPrompt,
    tabletopId,
    engineId,
    commandCompactId,
    registeredSettings,
    selected,
    commandsHandle: commands,
  };
} catch (error) {
  if (commandCompactId !== undefined) await root.loader.remove(commandCompactId);
  if (engineId !== undefined) await root.loader.remove(engineId);
  if (tabletopId !== undefined) await root.loader.remove(tabletopId);
  await loader.dispose();
  await fsObservationHandle.dispose();
  await fsHandle.dispose();
  await agents.dispose();
  await commands.dispose();
  await persistence.dispose();
  await tokenMeter.dispose();
  await projections.dispose();
  await sessions.dispose();
  await tools.dispose();
  await llmPlugin.dispose();
  await systemPrompt.dispose();
  await domainFacility.closeAll();
  unregisterBackend();
  await backend.close();
  await storage.dispose();
  throw error;
}
}

async function disposeHost(host) {
  if (host.commandCompactId !== undefined) await host.loader.remove(host.commandCompactId);
  if (host.engineId !== undefined) await host.loader.remove(host.engineId);
  if (host.tabletopId !== undefined) await host.loader.remove(host.tabletopId);
  await host.handle?.dispose();
  await host.loaderHandle.dispose();
  await host.agentsHandle.dispose();
  await host.commandsHandle.dispose();
  await host.persistenceHandle.dispose();
  await host.tokenMeterHandle.dispose();
  await host.projectionsHandle.dispose();
  await host.sessionsHandle.dispose();
  await host.toolsHandle.dispose();
  await host.fsObservationHandle.dispose();
  await host.fsHandle.dispose();
  await host.llmHandle.dispose();
  await host.systemPromptHandle.dispose();
  await host.closeStorage();
}

const firstHost = await createHost();
const interruptedSessionId = SessionId("session-72d5a5e5-1c4b-4f8e-9d38-1b7f2e6c4a90");
const firstSessionId = SessionId("session-baf851a1-8ae5-4672-82f9-fe25968781d2");
const secondSessionId = SessionId("session-4c6d7e8f-9012-4a5b-b6c7-d8e9f0123456");
const interruptedPreparation = SessionPreparation.create(
  firstHost.sessions.prepare(interruptedSessionId),
);
const interruptedSession = interruptedPreparation.session;
const detachInterrupted = firstHost.sessions.enter(interruptedSession);
firstHost.sessions.announce(interruptedSession);
interruptedSession.append("turn/start", { turn: 1 });
interruptedSession.append("step/start", { turn: 1, step: 1 });
interruptedSession.append(
  "user/message",
  createUserMessage({
    content: [{ type: "text", text: "Run the interrupted operation." }],
    source: { kind: "user" },
  }),
  { surfaceOp: "append" },
);
const interruptedCallId = ToolCallId("call-interrupted");
interruptedSession.append(
  "assistant/message",
  {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: "tool-call", id: interruptedCallId, name: "roll_dice", arguments: "{}" },
      ],
      source: { provider: "openai", model: "gpt-5.6-sol" },
    }),
  },
  { surfaceOp: "append" },
);
interruptedSession.append("tool/call", {
  turn: 1,
  step: 1,
  callId: interruptedCallId,
  name: "roll_dice",
  arguments: "{}",
});
await firstHost.sessions.flush(interruptedSession);
detachInterrupted();
interruptedPreparation[Symbol.dispose]();
const recovered = await firstHost.persistence.load(interruptedSession.id);
assert.equal(recovered.events.at(-1)?.type, "turn/end");
assert.equal(
  recovered.events.filter((event) => event.type === "tool/result").length,
  1,
);
assert.equal(
  recovered.events.find((event) => event.type === "turn/end")?.data.reason.kind,
  "interrupted",
);
const firstHandle = await firstHost.root.agents.create({
  sessionId: firstSessionId,
  meta: { cwd: ${JSON.stringify(workspaceA)} },
  agentOptions: firstHost.selected,
  setup: (agentCtx) => {
    installModelSelection(agentCtx, {
      current: firstHost.selected,
      assembled: undefined,
    });
  },
});
const firstAgent = firstHandle.agent;
assert.equal(firstAgent.session.id, firstSessionId);
const secondHandle = await firstHost.root.agents.create({
  sessionId: secondSessionId,
  meta: { cwd: ${JSON.stringify(workspaceB)} },
  agentOptions: firstHost.selected,
  setup: (agentCtx) => {
    installModelSelection(agentCtx, {
      current: firstHost.selected,
      assembled: undefined,
    });
  },
});
const secondAssembly = await firstHost.systemPrompt.assemble(
  assembleContextFor(secondHandle.agent),
);
const secondPrompt = renderPrompt(secondAssembly);
assert.match(secondPrompt, /You are an AI agent powered by DeepSeek Harness/u);
assert.ok(
  secondPrompt.includes(firstHost.selected.model),
  secondPrompt,
);
assert.ok(
  secondPrompt.includes(workspaceB),
  secondPrompt,
);
await secondHandle.dispose();
const pressureText = "x".repeat(1_100_000);
const firstUser = createUserMessage({
  content: [{ type: "text", text: "Roll one six-sided die and report that it worked." }],
  source: { kind: "user" },
});
firstAgent.followup(firstUser);
await firstAgent.whenIdle();
const fallbackLogs = firstHost.root.logger.buffer.filter(
  (message) => message.name === "dsh-nanocodex.transport",
);
assert.equal(fallbackLogs.length, 1, JSON.stringify(firstHost.root.logger.buffer));
const fallbackDiagnostic = fallbackLogs[0]?.args.find(
  (value) => value && typeof value === "object" && value.kind === "nanocodex.transport_fallback",
);
assert.deepEqual(fallbackDiagnostic, {
  kind: "nanocodex.transport_fallback",
  session_id: String(firstSessionId),
  request_id: normalizedSessionId,
  error_class: "websocket_fallback",
  previous_transport: "responses_websocket_v2",
  next_transport: "responses_https_sse",
  reason: "upgrade_required",
});
assert.doesNotMatch(JSON.stringify(fallbackLogs), /pack-smoke-key|private|prompt/iu);
const rawPatchTarget = await firstHost.root.fs.resolve("raw-apply-patch.txt", {
  cwd: workspaceA,
});
assert.equal(
  await firstHost.root.fs.readText(rawPatchTarget),
  "created by raw apply_patch\\n",
);
const rawPatchCall = firstAgent.session
  .snapshotEvents()
  .find(
    (event) =>
      event.type === "tool/call" && event.data.callId === "call-apply-patch",
  );
assert.ok(rawPatchCall, "the model custom call must enter the DSH tool runtime");
assert.deepEqual(JSON.parse(rawPatchCall.data.arguments), { patch: rawPatch });
const rawPatchResult = firstAgent.session
  .snapshotEvents()
  .find(
    (event) =>
      event.type === "tool/result" &&
      event.data.message.source.callId === "call-apply-patch",
  );
assert.ok(rawPatchResult, "the raw patch must have a durable DSH result");
assert.equal(rawPatchResult.data.message.content[0]?.isError, false);
assert.deepEqual(rawPatchResult.data.meta, {
  diffs: [
    {
      path: "raw-apply-patch.txt",
      oldText: null,
      newText: "created by raw apply_patch\\n",
    },
  ],
});
const events = firstAgent.session.snapshotEvents();
const modelSteps = events.filter((event) => event.type === "step/start");
const modelMessages = events.filter((event) => event.type === "assistant/message");
assert.deepEqual(modelSteps.map((event) => event.data.step), [1, 2]);
assert.deepEqual(modelMessages.map((event) => event.data.step), [1, 2]);
assert.equal(modelMessages[0].data.message.content[0].text, "I will roll the die, then report the result.");
assert.deepEqual(modelMessages[0].data.message.content.filter((block) => block.type === "tool-call").map((block) => block.name), ["exec", "apply_patch"]);
const parentCalls = events.filter((event) => event.type === "tool/call");
const parentResults = events.filter((event) => event.type === "tool/result");
assert.equal(parentCalls.length, 2);
assert.equal(parentResults.length, 2);
assert.ok(parentCalls.every((event) => event.seq > modelMessages[0].seq));
assert.ok(parentResults.every((event) => event.seq < modelMessages[1].seq));
assert.equal(events.filter((event) => event.type === "tool/code-dispatch").length, 1);
const firstTurnStart = events.findIndex((event) => event.type === "turn/start");
const firstTurnEnd = events.findIndex((event) => event.type === "turn/end");
assert.ok(firstTurnStart >= 0 && firstTurnEnd > firstTurnStart);
assert.deepEqual(deriveTurnTokenUsage(events.slice(firstTurnStart, firstTurnEnd + 1)), {
  uncachedInputTokens: 24, outputTokens: 12, totalTokens: 48,
  cacheReadTokens: 12, cacheWriteTokens: 0, reasoningTokens: 0,
  routes: [{ provider: "openai", model: "gpt-5.6-terra" }],
});
const usageChunks = events.filter(
  (event) => event.type === "assistant/chunk" && event.data.chunk.type === "usage",
);
assert.equal(usageChunks.length, 2, "each model request must publish usage, excluding warmup");
assert.deepEqual(usageChunks.map((event) => event.data.chunk.usage.inputTokens), [18, 6]);
assert.deepEqual(usageChunks.map((event) => event.data.chunk.usage.cacheReadTokens), [0, 12]);
for (const event of events.filter((event) => event.type === "request/context")) {
  assert.equal(event.data.contextWindow, 200_000, "checkpoints must preserve the model window");
}
const pressure = firstHost.root.sessionProjections.snapshot(firstAgent.session).values.contextPressure;
assert.equal(pressure.contextWindow, 200_000);
assert.equal(pressure.pressureTokens, 18, "context pressure must use the latest request, not the turn total");
assert.ok(pressure.projectedTokens > 0, "both clients must receive a visible context meter value");
const checkpointStore = firstHost.root.storageDomain.get("nanocodex_checkpoints").table("sessions");
const firstCheckpoint = checkpointStore.get(firstAgent.session.id);
assert.ok(firstCheckpoint);
assert.ok(events.filter(event => event.type === "request/context").every(event => JSON.stringify(event).length < 1024), "browser context events must exclude private snapshots");
assert.deepEqual(firstCheckpoint.boundary.surfaceSeqs, firstAgent.session.surface.nodes);
const messages = firstAgent.session.deriveMessages();
const assistantMessages = messages.filter((message) => message.role === "assistant");
assert.equal(assistantMessages.length, 2);
assert.equal(
  assistantMessages.at(-1)?.content[0]?.type,
  "text",
);
assert.equal(
  assistantMessages.at(-1)?.content[0]?.type === "text"
    ? assistantMessages.at(-1)?.content[0]?.text
    : undefined,
  "The tabletop tool worked and state was stored.",
);
const toolResult = messages.find((message) => message.role === "user" && message.content[0]?.type === "tool-result");
assert.ok(toolResult);
if (toolResult?.content[0]?.type !== "tool-result") throw new Error("missing tabletop result");
assert.equal(toolResult.content[0].isError, false);
assert.match(toolResult.content[0].content.filter((part) => part.type === "text").map((part) => part.text).join(""), /rolls/iu);
assert.equal(firstHost.root.agents.get(firstAgent.id), firstAgent);
firstAgent.followup(createUserMessage({
  content: [{
    type: "text",
    text: "Read the Code Mode value from the previous turn.",
  }],
  source: { kind: "user" },
}));
await firstAgent.whenIdle();
assert.equal(
  firstAgent.session.deriveMessages().at(-1)?.content[0]?.type === "text"
    ? firstAgent.session.deriveMessages().at(-1)?.content[0]?.text
  : undefined,
  "Code Mode state survived the follow-up.",
);
const controllerAgent = firstHost.root.agents.get(firstAgent.id);
assert.equal(controllerAgent, firstAgent);
if (controllerAgent === undefined) throw new Error("live Agent lookup failed");
const manualCompaction = await firstHost.root.commands.execute(
  controllerAgent,
  "/compact",
  [],
  new AbortController().signal,
);
assert.ok(manualCompaction, "the official command plane must resolve /compact");
assert.equal(
  manualCompaction.result.kind,
  "success",
  JSON.stringify(manualCompaction),
);
const manualCheckpoint = checkpointStore.get(firstAgent.session.id);
assert.ok(
  manualCheckpoint,
  "manual compaction must persist an engine checkpoint before continuation",
);
assert.deepEqual(
  manualCheckpoint.boundary.surfaceSeqs,
  firstAgent.session.surface.nodes,
);
assert.equal(
  manualCheckpoint.boundary.messageCount,
  firstAgent.session.deriveMessages().length,
);
assert.ok(
  manualCheckpoint.snapshot.history.some(
    (item) => JSON.stringify(item).includes("Manual compaction preserved"),
  ),
  "manual checkpoint must be the engine-owned post-replacement snapshot",
);
firstAgent.followup(createUserMessage({
  content: [{
    type: "text",
    text: "Continue after manual compaction.",
  }],
  source: { kind: "user" },
}));
await firstAgent.whenIdle();
assert.equal(
  firstAgent.session.deriveMessages().at(-1)?.content[0]?.type === "text"
    ? firstAgent.session.deriveMessages().at(-1)?.content[0]?.text
  : undefined,
  "Manual compaction preserved the active tail.",
);
firstAgent.followup(createUserMessage({
  content: [{
    type: "text",
    text: "Confirm automatic compaction preserved the active tail. " + pressureText,
  }],
  source: { kind: "user" },
}));
await firstAgent.whenIdle();
assert.equal(
  firstAgent.session.deriveMessages().at(-1)?.content[0]?.type === "text"
    ? firstAgent.session.deriveMessages().at(-1)?.content[0]?.text
  : undefined,
  "Automatic compaction preserved the active tail.",
);
await firstHost.sessions.flush(firstAgent.session);
const firstToolCalls = firstAgent.session.snapshotEvents().filter((event) => event.type === "tool/call").length;
assert.equal(firstToolCalls, 3);
assert.equal(
  firstAgent.session.snapshotEvents().filter((event) => event.type === "compaction/summary").length,
  2,
);
assert.equal(
  firstAgent.session.deriveMessages().filter(
    (message) => message.source.kind === "plugin" && message.source.plugin === "compact",
  ).length,
  1,
);
await disposeHost({ ...firstHost, handle: firstHandle });

const resumedHost = await createHost();
const resumedHandle = await resumedHost.root.agents.resume({
  resumeSessionId: firstSessionId,
  agentOptions: resumedHost.selected,
  setup: (agentCtx) => {
    installModelSelection(agentCtx, {
      current: resumedHost.selected,
      assembled: undefined,
    });
  },
});
const resumedAgent = resumedHandle.agent;
const loadedCheckpoint = resumedHost.root.storageDomain.get("nanocodex_checkpoints").table("sessions").get(resumedAgent.session.id);
assert.ok(loadedCheckpoint, "cold Host must load the persisted Nanocodex checkpoint");
const resumedPressure = resumedHost.root.sessionProjections.snapshot(resumedAgent.session).values.contextPressure;
assert.equal(resumedPressure.contextWindow, 200_000);
assert.ok(resumedPressure.pressureTokens > 0, "cold replay must retain the usage anchor");
assert.ok(resumedPressure.projectedTokens > 0, "cold replay must retain a visible meter");
assert.equal(
  loadedCheckpoint.boundary.messageCount,
  resumedAgent.session.deriveMessages().length,
);
resumedAgent.followup(createUserMessage({
  content: [{ type: "text", text: "Continue after a matching checkpoint resume." }],
  source: { kind: "user" },
}));
await resumedAgent.whenIdle();
await resumedHost.sessions.flush(resumedAgent.session);
assert.equal(resumedAgent.id, firstSessionId);
assert.equal(
  resumedAgent.session.snapshotEvents().filter((event) => event.type === "tool/call").length,
  firstToolCalls,
);
resumedAgent.session.append("user/message", createUserMessage({
  content: [{ type: "text", text: "Checkpoint boundary changed before cold resume." }],
  source: { kind: "user" },
}), { surfaceOp: "append" });
const legacyAssistant = createAssistantMessage({
  content: [
    { type: "reasoning", text: "legacy private reasoning fixture" },
    { type: "text", text: "Legacy visible answer survives hydration." },
    {
      type: "tool-call",
      id: ToolCallId("call_" + "p".repeat(24) + "|ctc_" + "p".repeat(50)),
      name: "apply_patch",
      arguments: JSON.stringify({ patch: "*** Begin Patch\\n*** End Patch\\n" }),
    },
  ],
  source: { provider: "openai", model: "gpt-5.6-sol" },
});
resumedAgent.session.append("assistant/message", {
  turn: 0,
  step: 0,
  message: legacyAssistant,
}, { surfaceOp: "append" });
const historicalPatch = legacyAssistant.content.find((block) => block.type === "tool-call");
const historicalCall = resumedAgent.session.append("tool/call", {
  turn: 0,
  step: 0,
  callId: historicalPatch.id,
  name: historicalPatch.name,
  arguments: historicalPatch.arguments,
});
resumedAgent.session.append("tool/result", {
  turn: 0,
  step: 0,
  message: createToolResultMessage({
    callId: historicalPatch.id,
    content: [{ type: "text", text: "Historical patch completed." }],
    isError: false,
  }),
}, { surfaceOp: "append", sourceEventSeqs: [historicalCall.seq] });
await resumedHost.sessions.flush(resumedAgent.session);
await disposeHost({ ...resumedHost, handle: resumedHandle });

const changedHost = await createHost();
const changedHandle = await changedHost.root.agents.resume({
  resumeSessionId: firstSessionId,
  agentOptions: changedHost.selected,
  setup: (agentCtx) => {
    installModelSelection(agentCtx, {
      current: changedHost.selected,
      assembled: undefined,
    });
  },
});
const changedAgent = changedHandle.agent;
assert.deepEqual(
  changedAgent.session.deriveMessages().find((message) => message.id === legacyAssistant.id)?.content,
  legacyAssistant.content,
  "cold resume must preserve the original DSH reasoning record",
);
changedAgent.followup(createUserMessage({
  content: [{ type: "text", text: "Continue after a cold Host restart." }],
  source: { kind: "user" },
}));
await changedAgent.whenIdle();
await changedHost.sessions.flush(changedAgent.session);
assert.equal(changedAgent.id, firstSessionId);
assert.equal(
  changedAgent.session.snapshotEvents().filter((event) => event.type === "tool/call").length,
  firstToolCalls + 1,
);
assert.equal(changedAgent.session.snapshotEvents().filter((event) => event.type === "tool/result").length, 4);

const changedNodes = [...changedAgent.session.surface.nodes];
const changedMessages = changedAgent.session.deriveMessages();
let latestRealUserIndex = -1;
for (let index = changedMessages.length - 1; index >= 0; index -= 1) {
  const message = changedMessages[index];
  if (message?.role === "user" && message.source.kind === "user") {
    latestRealUserIndex = index;
    break;
  }
}
assert.ok(latestRealUserIndex > 0);
const firstSurfaceNode = changedNodes[0];
const supportedPrefixEnd = changedNodes[latestRealUserIndex - 1];
assert.ok(firstSurfaceNode !== undefined);
assert.ok(supportedPrefixEnd !== undefined);
const compacted = await changedHost.root.compaction.compactRegion(
  firstSurfaceNode,
  supportedPrefixEnd,
  changedAgent,
  new AbortController().signal,
);
assert.match(compacted.summary[0]?.type === "text" ? compacted.summary[0].text : "", /The User/u);
assert.equal(
  changedAgent.session.deriveMessages().some(
    (message) => message.source.kind === "plugin" && message.source.plugin === "compact",
  ),
  true,
);
const ancillaryText = [];
for await (const chunk of changedHost.root.llm.stream({
  provider: "openai",
  model: "gpt-5.6-sol",
  messages: [
    createUserMessage({
      content: [{ type: "text", text: "Earlier context for the ancillary request." }],
      source: { kind: "user" },
    }),
    createUserMessage({
      content: [{ type: "text", text: "Run the ancillary session-title request." }],
      source: { kind: "user" },
    }),
  ],
  system: "Use the ancillary Nanocodex route.",
  tools: [],
  sessionId: firstSessionId,
  purpose: "session-title",
  signal: new AbortController().signal,
})) {
  if (chunk.type === "text-delta") ancillaryText.push(chunk.text);
}
assert.equal(ancillaryText.join(""), "Ancillary LLM route worked.");
await disposeHost({ ...changedHost, handle: changedHandle });
console.log("nanocodex-loader: packed Host, actual WASM/QuickJS turn, DSH tabletop bridge, cold resume, compaction, and unload passed");
`;
}

const cli = resolve(configuredCli);
const invocation = dshInvocation(cli);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "dsh-nanocodex-pack-smoke-"),
);
const workspaceA = join(temporaryDirectory, "agent-workspace-a");
const workspaceB = join(temporaryDirectory, "agent-workspace-b");
const normalizedSessionId = "baf851a1-8ae5-4672-82f9-fe25968781d2";
await mkdir(workspaceA, { recursive: true });
await mkdir(workspaceB, { recursive: true });
const sockets = new Set<Socket>();
let requestCount = 0;
let modelRequestCount = 0;
let warmupSeen = false;
let upgradeCount = 0;
let firstProviderSessionId: string | undefined;
let serverFailure: unknown;
async function handleProviderRequest(
  request: JsonObject,
  response: ServerResponse,
): Promise<void> {
  try {
    const providerSessionId = request.client_metadata?.session_id;
    assert.equal(typeof providerSessionId, "string");
    assert.match(providerSessionId, NANOCODEX_SESSION_ID);
    assert.equal(providerSessionId.startsWith("session-"), false);
    if (modelRequestCount < 11) {
      assert.equal(request.client_metadata?.thread_id, normalizedSessionId);
    }
    // The first turn establishes the normalized provider lineage. Resume and
    // compaction operations may use a fresh Nanocodex provider lineage while
    // retaining the DSH-derived thread identity.
    if (firstProviderSessionId === undefined) {
      firstProviderSessionId = providerSessionId;
      assert.equal(providerSessionId, normalizedSessionId);
    }
    requestCount += 1;
    const isWarmup = request.generate === false;
    if (isWarmup) {
      warmupSeen = true;
      assert.equal(request.generate, false);
      const toolCatalog = request.input.find((item: JsonObject) =>
        Array.isArray(item.tools),
      ).tools;
      assert.deepEqual(
        toolCatalog.map((tool: JsonObject) => tool.name),
        ["exec", "wait", "apply_patch"],
        "the adapter must not expose Nanocodex subagent tools",
      );
      assert.match(
        toolCatalog.find((tool: JsonObject) => tool.name === "exec")
          ?.description ?? "",
        /roll_dice/,
      );
      assert.match(
        toolCatalog.find((tool: JsonObject) => tool.name === "apply_patch")
          ?.description ?? "",
        /Add File.*Update File/isu,
      );
      assert.ok(
        JSON.stringify(request).includes(workspaceA),
        "provider warmup instructions must include the Agent workspace",
      );
      await sendSse(response, {
        type: "response.completed",
        response: { id: "pack-warmup", status: "completed", usage: null },
      });
    } else {
      modelRequestCount += 1;
      for (const item of request.input ?? []) {
        if (typeof item.call_id === "string") {
          assert.match(item.call_id, /^[a-zA-Z0-9_-]{1,64}$/u);
        }
      }
      if (modelRequestCount < 12) {
        assert.equal(request.client_metadata?.thread_id, normalizedSessionId);
      } else {
        assert.match(request.client_metadata?.thread_id, NANOCODEX_SESSION_ID);
        assert.notEqual(
          request.client_metadata?.thread_id,
          normalizedSessionId,
        );
      }
      if (modelRequestCount === 1) {
        assert.equal(
          request.previous_response_id,
          warmupSeen ? "pack-warmup" : undefined,
        );
        await sendSse(
          response,
          completedResponse("pack-tool", [
            {
              type: "message",
              id: "message-before-tools",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "I will roll the die, then report the result.",
                },
              ],
            },
            {
              type: "custom_tool_call",
              id: "tool-exec",
              call_id: "call-exec",
              name: "exec",
              input:
                'store("pack-state", "state-from-first-turn"); text(await tools.roll_dice({ sides: 6 }));',
            },
            {
              type: "custom_tool_call",
              id: "tool-apply-patch",
              call_id: "call-apply-patch",
              name: "apply_patch",
              input: rawPatch,
            },
          ]),
        );
      } else if (modelRequestCount === 2) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(JSON.stringify(request.input), /rolls/iu);
        await sendSse(
          response,
          completedResponse(
            "pack-final",
            [
              {
                type: "message",
                id: "message-final",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "The tabletop tool worked and state was stored.",
                  },
                ],
              },
            ],
            24,
            12,
          ),
        );
      } else if (modelRequestCount === 3) {
        assert.equal(request.previous_response_id, undefined);
        await sendSse(
          response,
          completedResponse("pack-state", [
            {
              type: "custom_tool_call",
              id: "tool-state",
              call_id: "call-state",
              name: "exec",
              input: 'text(load("pack-state"));',
            },
          ]),
        );
      } else if (modelRequestCount === 4) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(JSON.stringify(request.input), /state-from-first-turn/iu);
        await sendSse(
          response,
          completedResponse(
            "pack-follow-up",
            [
              {
                type: "message",
                id: "message-follow-up",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Code Mode state survived the follow-up.",
                  },
                ],
              },
            ],
            260_000,
          ),
        );
      } else if (modelRequestCount === 5) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(JSON.stringify(request.input), /compaction|The User/iu);
        await sendSse(
          response,
          completedResponse("pack-manual-summary", [
            {
              type: "message",
              id: "message-manual-summary",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Manual compaction preserved the active tail.",
                },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 6) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(
          JSON.stringify(request.input),
          /Continue after manual compaction/iu,
        );
        await sendSse(
          response,
          completedResponse(
            "pack-manual-final",
            [
              {
                type: "message",
                id: "message-manual-final",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "Manual compaction preserved the active tail.",
                  },
                ],
              },
            ],
            260_000,
          ),
        );
      } else if (modelRequestCount === 7) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(
          JSON.stringify(request.input),
          /compaction|Continue after manual compaction/iu,
        );
        await sendSse(
          response,
          completedResponse("pack-auto-summary", [
            {
              type: "message",
              id: "message-auto-summary",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: [
                    "## The User",
                    "- The user has an active Code Mode state.",
                    "## Our Relationship",
                    "- Continue accurately.",
                    "## Emotional Continuity",
                    "- (none)",
                    "## Shared Moments",
                    "- (none)",
                    "## Preferences and Boundaries",
                    "- (none)",
                    "## Commitments and Open Threads",
                    "- Preserve the active tail.",
                    "## Current Moment",
                    "- The user is checking continuity.",
                    "## Continue Naturally",
                    "- Confirm the retained state.",
                  ].join("\n"),
                },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 8) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(
          JSON.stringify(request.input),
          /automatic compaction preserved the active tail/iu,
        );
        await sendSse(
          response,
          completedResponse("pack-auto-final", [
            {
              type: "message",
              id: "message-auto-final",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Automatic compaction preserved the active tail.",
                },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 9) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(JSON.stringify(request.input), /matching checkpoint/iu);
        await sendSse(
          response,
          completedResponse("pack-checkpoint-final", [
            {
              type: "message",
              id: "message-checkpoint",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Matching checkpoint resume worked.",
                },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 10) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(JSON.stringify(request.input), /cold Host restart/iu);
        assert.match(
          JSON.stringify(request.input),
          /checkpoint boundary changed/iu,
        );
        assert.match(
          JSON.stringify(request.input),
          /Legacy visible answer survives hydration/u,
        );
        assert.match(
          JSON.stringify(request.input),
          /Historical patch completed/u,
        );
        const historicalCallId = "call_" + "p".repeat(24);
        const historicalPair = request.input.filter(
          (item: JsonObject) => item.call_id === historicalCallId,
        );
        assert.deepEqual(
          historicalPair.map((item: JsonObject) => item.type),
          ["custom_tool_call", "custom_tool_call_output"],
        );
        assert.doesNotMatch(
          JSON.stringify(request.input),
          /legacy private reasoning fixture/u,
        );
        await sendSse(
          response,
          completedResponse("pack-cold-final", [
            {
              type: "message",
              id: "message-cold",
              role: "assistant",
              content: [
                { type: "output_text", text: "Cold Host resume worked." },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 11) {
        assert.match(JSON.stringify(request.input), /compaction|The User/iu);
        await sendSse(
          response,
          completedResponse("pack-compact", [
            {
              type: "message",
              id: "message-compact",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: [
                    "## The User",
                    "## The Companion",
                    "## Shared Facts",
                    "## Open Threads",
                    "## Recent Tone",
                    "## Continuity Rules",
                  ].join("\n"),
                },
              ],
            },
          ]),
        );
      } else if (modelRequestCount === 12) {
        assert.equal(request.previous_response_id, undefined);
        assert.match(
          JSON.stringify(request.input),
          /ancillary session-title request/iu,
        );
        await sendSse(
          response,
          completedResponse("pack-ancillary", [
            {
              type: "message",
              id: "message-ancillary",
              role: "assistant",
              content: [
                { type: "output_text", text: "Ancillary LLM route worked." },
              ],
            },
          ]),
        );
      } else {
        throw new Error(`unexpected provider request ${modelRequestCount}`);
      }
    }
  } catch (error) {
    serverFailure = error;
    response.destroy(error instanceof Error ? error : undefined);
  }
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const body = await requestBody(request);
      await handleProviderRequest(JSON.parse(body) as JsonObject, response);
    } catch (error) {
      serverFailure ??= error;
      response.destroy(error instanceof Error ? error : undefined);
    }
  })();
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
server.on("upgrade", (_request, socket) => {
  upgradeCount += 1;
  const body = Buffer.from("WebSocket transport disabled in fixture");
  socket.write(
    `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
  );
  socket.end(body);
});

try {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("listening", () => resolveListen());
    server.once("error", rejectListen);
  });
  const address = server.address() as AddressInfo;
  const websocketUrl = `ws://127.0.0.1:${address.port}/v1/responses`;
  const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  assert.deepEqual(checkPackedFiles(root, engineEntry), []);
  assert.deepEqual(checkPackedFiles(root, tabletopEntry), []);
  assert.deepEqual(checkPackedFiles(root, companionEntry), []);
  const engineArtifact = packRelease(root, engineEntry, temporaryDirectory);
  const tabletopArtifact = packRelease(root, tabletopEntry, temporaryDirectory);
  const companionArtifact = packRelease(
    root,
    companionEntry,
    temporaryDirectory,
  );
  const engineFiles = execFileSync("tar", ["-tzf", engineArtifact], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const required of [
    "package/dist/index.js",
    "package/cordis.patch.yml",
    "package/THIRD_PARTY_NOTICES.md",
    "package/vendor/nanocodex/node/index.mjs",
    "package/vendor/nanocodex/pkg-web/nanocodex_bg.wasm",
    "package/vendor/nanocodex-tools/runtime/code-runtime.mjs",
  ]) {
    assert.ok(engineFiles.includes(required), `artifact omits ${required}`);
  }
  assert.equal(
    engineFiles.some(
      (file) => file.endsWith(".tgz") || file.includes("node_modules"),
    ),
    false,
  );
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOzf", engineArtifact, "package/package.json"], {
      encoding: "utf8",
    }),
  ) as JsonObject;
  assert.equal(manifest.name, engineEntry.name);
  assert.equal(manifest.dependencies.nanocodex, undefined);
  assert.equal(manifest.dependencies["nanocodex-tools"], undefined);
  assert.equal(JSON.stringify(manifest).includes("workspace:"), false);

  const dshHome = join(temporaryDirectory, "dsh-home");
  const cwd = join(temporaryDirectory, "runtime-cwd");
  await mkdir(cwd, { recursive: true });
  const env = isolatedEnvironment(temporaryDirectory, dshHome);
  assert.equal(
    execFileSync(invocation.command, [...invocation.args, "--version"], {
      cwd,
      env,
      encoding: "utf8",
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
      "nanocodex-smoke",
      "add",
      engineArtifact,
      tabletopArtifact,
      companionArtifact,
      "--ignore-scripts",
    ],
    { cwd, env, stdio: "inherit" },
  );
  const dump = execFileSync(
    invocation.command,
    [...invocation.args, "--profile", "nanocodex-smoke", "--dump-config"],
    { cwd, env, encoding: "utf8" },
  );
  assert.match(dump, /@lamplitisles\/dsh-nanocodex/u);
  assert.match(dump, /@lamplitisles\/dsh-tabletop/u);
  assert.match(dump, /agent-loop[\s\S]*disabled/u);

  const profile = join(dshHome, "profiles", "nanocodex-smoke");
  const enginePath = join(
    profile,
    "node_modules",
    "@lamplitisles",
    "dsh-nanocodex",
  );
  const tabletopPath = join(
    profile,
    "node_modules",
    "@lamplitisles",
    "dsh-tabletop",
  );
  assert.ok(
    existsSync(
      join(enginePath, "vendor", "nanocodex", "pkg-web", "nanocodex_bg.wasm"),
    ),
  );
  const engineActivation = join(temporaryDirectory, "activate-nanocodex.mjs");
  const tabletopActivation = join(temporaryDirectory, "activate-tabletop.mjs");
  const commandCompactActivation = join(
    temporaryDirectory,
    "activate-command-compact.mjs",
  );
  await writeFile(
    engineActivation,
    `export { apply, inject, name } from ${JSON.stringify(pathToFileURL(join(enginePath, "dist", "index.js")).href)};\n`,
  );
  await writeFile(
    tabletopActivation,
    `export { apply, inject, name } from ${JSON.stringify(pathToFileURL(join(tabletopPath, "dist", "index.js")).href)};\n`,
  );
  const commandCompactPath = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module"; console.log(createRequire(${JSON.stringify(pathToFileURL(join(profile, "package.json")).href)}).resolve("@deepseek-ai/dsh-command-compact"));`,
    ],
    { encoding: "utf8" },
  ).trim();
  await writeFile(
    commandCompactActivation,
    `export { apply, inject, name } from ${JSON.stringify(pathToFileURL(commandCompactPath).href)};\n`,
  );

  const runnerPath = join(temporaryDirectory, "loader-runner.mjs");
  const resolver = (specifier: string): string => {
    const packageRoot = join(profile, "node_modules");
    const packagePath = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { createRequire } from "node:module"; console.log(createRequire(${JSON.stringify(pathToFileURL(join(profile, "package.json")).href)}).resolve(${JSON.stringify(specifier)}));`,
      ],
      { encoding: "utf8" },
    ).trim();
    void packageRoot;
    return pathToFileURL(packagePath).href;
  };
  await writeFile(
    runnerPath,
    runnerSource({
      activationUrl: pathToFileURL(engineActivation).href,
      tabletopActivationUrl: pathToFileURL(tabletopActivation).href,
      cordisUrl: resolver("@deepseek-ai/cordis"),
      fsLocalUrl: resolver("@deepseek-ai/dsh-fs-local"),
      fsObservationUrl: resolver("@deepseek-ai/dsh-fs-observation-policy"),
      loaderUrl: resolver("@deepseek-ai/cordis-plugin-loader"),
      agentUrl: resolver("@deepseek-ai/dsh-agent"),
      sessionUrl: resolver("@deepseek-ai/dsh-session"),
      tokenMeterUrl: resolver("@deepseek-ai/dsh-token-meter"),
      tokenMeterClientUrl: resolver("@deepseek-ai/dsh-token-meter/client"),
      sessionProjectionUrl: resolver("@deepseek-ai/dsh-session-projection"),
      systemPromptUrl: resolver("@deepseek-ai/dsh-system-prompt"),
      toolsUrl: resolver("@deepseek-ai/dsh-tools"),
      llmUrl: resolver("@deepseek-ai/dsh-llm"),
      sessionControllerUrl: resolver("@deepseek-ai/dsh-api-session-controller"),
      persistenceJsonlUrl: resolver(
        "@deepseek-ai/dsh-session-persistence-jsonl",
      ),
      commandsUrl: resolver("@deepseek-ai/dsh-commands"),
      storageUrl: resolver("@deepseek-ai/dsh-storage"),
      storageJsonUrl: resolver("@deepseek-ai/dsh-storage-json"),
      storageDomainUrl: resolver("@deepseek-ai/dsh-storage-domain"),
      commandCompactActivationUrl: pathToFileURL(commandCompactActivation).href,
      persistenceRoot: join(temporaryDirectory, "session-logs"),
      workspaceA,
      workspaceB,
      baseUrl: websocketUrl,
      apiBaseUrl,
    }),
  );
  await runChild(process.execPath, ["--expose-internals", runnerPath], {
    cwd: temporaryDirectory,
    env,
  });
  await runChild(
    process.execPath,
    [
      resolve(root, "packages/dsh-nanocodex/scripts/web-composed-smoke.mjs"),
      engineArtifact,
      companionArtifact,
    ],
    {
      cwd: temporaryDirectory,
      env: { ...env, DSH_CLI: cli },
    },
  );
  if (serverFailure !== undefined) throw serverFailure;
  assert.equal(
    upgradeCount >= 1,
    true,
    "the fixture must exercise a rejected WebSocket upgrade",
  );
  assert.equal(requestCount, 12);
  console.log(
    JSON.stringify(
      {
        package: engineEntry.name,
        packed: true,
        host: true,
        loader: true,
        wasm: true,
        quickjs: true,
        websocketUpgradeAttempts: upgradeCount,
        sseFallback: true,
        fallbackDiagnostic: true,
        dshTool: "roll_dice",
        providerRequests: requestCount,
        automaticCompactions: true,
        tabletop: true,
        unload: true,
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  await rm(temporaryDirectory, { recursive: true, force: true });
}
