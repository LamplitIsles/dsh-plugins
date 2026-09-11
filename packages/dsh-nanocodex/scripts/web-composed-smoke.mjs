import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import {
  dshInvocation,
  isolatedEnvironment,
  jsonRequest,
  startRuntime,
  stopRuntime,
  authenticateRuntime,
} from "../../../scripts/dsh-web-smoke.mjs";
import { waitForFinalizedAssistant } from "./session-polling.mjs";

const artifact = process.argv[2];
const companionArtifact = process.argv[3];
const cli = process.env.DSH_CLI;
if (
  artifact === undefined ||
  companionArtifact === undefined ||
  cli === undefined
) {
  throw new Error(
    "web-composed-smoke requires engine and Companion artifacts plus DSH_CLI",
  );
}

const temp = await mkdtemp(join(tmpdir(), "dsh-nanocodex-web-smoke-"));
const home = join(temp, "dsh-home");
const cwd = join(temp, "workspace");
await mkdir(cwd, { recursive: true });
const env = {
  ...isolatedEnvironment(temp, home),
  PACK_SMOKE_API_KEY: "web-composed-smoke-key",
};

let runtime;
let server;
let sessionFollow;
let providerRequests = [];
let upgradeCount = 0;

function responseEvent(id, text) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: null,
    },
  };
}

async function sendSse(response, event) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-request-id": "web-composed-smoke",
    "x-codex-turn-state": "web-composed-turn",
  });
  const bytes = Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  for (let offset = 0; offset < bytes.length; offset += 5) {
    response.write(bytes.subarray(offset, offset + 5));
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end("data: [DONE]\n\n");
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForRequests(count) {
  const deadline = Date.now() + 10_000;
  while (providerRequests.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for provider request ${count}; got ${providerRequests.length}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function openSessionFollow({ baseUrl, cookie, sessionId }) {
  const socket = new WebSocket(
    new URL("/api/remote.mux", baseUrl).toString().replace(/^http/u, "ws"),
    { headers: { Cookie: cookie } },
  );
  const streamId = randomUUID();
  let records = [];
  let readyResolve;
  let readyReject;
  let readySettled = false;
  let failure;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const settleFailure = (error) => {
    if (failure === undefined) failure = error;
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
  };
  const send = (message) => socket.send(JSON.stringify(message));

  socket.once("open", () => {
    send({
      type: "open",
      streamId,
      endpoint: "session/follow",
      payload: {
        args: {
          request: {
            address: { kind: "session", sessionId },
            maxMessages: 100,
          },
        },
      },
    });
  });
  socket.on("message", (data) => {
    let frame;
    try {
      const text =
        typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      frame = JSON.parse(text);
    } catch (error) {
      settleFailure(new Error("invalid Remote stream frame", { cause: error }));
      return;
    }
    if (frame.streamId !== streamId) return;
    if (frame.type === "error") {
      settleFailure(new Error(frame.error?.message ?? "session follow failed"));
      return;
    }
    if (frame.type === "end") {
      settleFailure(new Error("session follow ended before shutdown"));
      return;
    }
    if (frame.type !== "item") {
      settleFailure(new Error("invalid Remote stream frame type"));
      return;
    }
    const value = frame.value;
    if (value?.type === "snapshot") {
      records = [...(value.records ?? [])];
      if (!readySettled) {
        readySettled = true;
        readyResolve();
      }
      return;
    }
    if (value?.type === "event") records = [...records, value];
  });
  socket.once("error", settleFailure);
  socket.once("close", () => {
    if (socket.readyState !== WebSocket.CLOSED) return;
    if (!readySettled) settleFailure(new Error("session follow closed"));
  });

  return {
    async ready() {
      await ready;
    },
    async page() {
      if (failure !== undefined) throw failure;
      return { records: [...records] };
    },
    async close() {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        if (socket.readyState === WebSocket.OPEN) {
          send({ type: "cancel", streamId });
        }
        socket.close();
      }
    },
  };
}

async function handleProviderRequest(request, response) {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = await requestBody(request);
  const parsed = JSON.parse(body);
  providerRequests.push({ body: parsed, raw: body });
  const isCompaction = body.includes(
    "You are creating a compact continuity checkpoint",
  );
  await sendSse(
    response,
    responseEvent(
      `web-composed-${providerRequests.length}`,
      isCompaction
        ? [
            "## The User",
            "- The user is checking the composed compaction owner.",
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
            "- The composed Web session is continuing.",
            "## Continue Naturally",
            "- Confirm continuity.",
          ].join("\n")
        : `Web composed reply ${providerRequests.length}`,
    ),
  );
}

async function main() {
  server = createServer((request, response) => {
    void handleProviderRequest(request, response);
  });
  server.on("upgrade", (_request, socket) => {
    upgradeCount += 1;
    const body = Buffer.from("WebSocket transport disabled in fixture");
    socket.end(
      `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n${body.toString()}`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  const port = server.address().port;
  const api = `http://127.0.0.1:${port}/v1`;
  const websocket = `ws://127.0.0.1:${port}/v1/responses`;
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "settings.yaml"),
    `llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: PACK_SMOKE_API_KEY\n      baseURL: ${api}\n      websocketURL: ${websocket}\n      reasoning: low\n`,
  );

  const invocation = dshInvocation(cli);
  execFileSync(
    invocation.command,
    [
      ...invocation.args,
      "plugin",
      "--profile",
      "web",
      "add",
      artifact,
      companionArtifact,
      "--ignore-scripts",
    ],
    { cwd, env, stdio: "inherit" },
  );
  await writeFile(
    join(home, "profiles", "web", "cordis.patch.yml"),
    "- id: agent-default-model\n  config:\n    provider: openai\n    model: gpt-5.6-sol\n",
  );

  runtime = await startRuntime(cli, env, cwd);
  const cookie = await authenticateRuntime(runtime);
  async function rpc(path, method, args) {
    const result = await jsonRequest(
      runtime.baseUrl,
      path,
      {
        type: "client-request",
        rpcId: `web-composed-${method}-${Date.now()}`,
        method,
        payload: { args },
      },
      cookie,
    );
    const value = result.value?.result;
    assert.equal(value?.ok, true, JSON.stringify(result.value));
    return value.value;
  }

  async function waitForAssistant(text) {
    return waitForFinalizedAssistant({
      expectedText: text,
      loadPage: () => sessionFollow.page(),
    });
  }

  const workspace = await rpc("/api/workspace/create", "workspace/create", {
    request: { path: cwd },
  });
  const workspaceId = workspace.workspace?.workspaceId;
  assert.equal(typeof workspaceId, "string", JSON.stringify(workspace));
  await rpc("/api/settings/update", "settings/update", {
    ns: "dsh-companion",
    patch: { workspaceId },
  });
  const sessionId = "session-00000000-0000-4000-8000-000000000099";
  const normalizedId = "00000000-0000-4000-8000-000000000099";
  await rpc("/api/session/create", "session/create", {
    request: { sessionId, workspaceId, agentPreset: "standard" },
  });
  sessionFollow = openSessionFollow({
    baseUrl: runtime.baseUrl,
    cookie,
    sessionId,
  });
  await sessionFollow.ready();
  const commands = await rpc("/api/commands/list", "commands/list", {
    agentId: sessionId,
  });
  assert.ok(commands.some((command) => command.name === "compact"));

  for (let index = 1; index <= 3; index += 1) {
    await rpc("/api/session/prompt", "session/prompt", {
      request: {
        sessionId,
        requestId: `web-composed-request-${index}`,
        content: [{ type: "text", text: `Composed prompt ${index}` }],
        mode: "queue",
      },
    });
    await waitForRequests(index);
    await waitForAssistant(`Web composed reply ${index}`);
  }

  const ordinaryRequest = providerRequests[0]?.body;
  assert.equal(ordinaryRequest?.client_metadata?.session_id, normalizedId);
  assert.equal(ordinaryRequest?.client_metadata?.thread_id, normalizedId);
  const beforeCompaction = providerRequests.length;
  const command = await rpc("/api/commands/execute", "commands/execute", {
    agentId: sessionId,
    line: "/compact",
    images: [],
  });
  assert.equal(command.result.kind, "success", JSON.stringify(command));
  assert.match(command.result.text, /^Compacted /u);
  await waitForRequests(beforeCompaction + 1);
  const compactionRequest = providerRequests.at(-1)?.raw ?? "";
  assert.match(compactionRequest, /compact continuity checkpoint/iu);
  assert.doesNotMatch(compactionRequest, /AI coding assistant/iu);

  await rpc("/api/session/prompt", "session/prompt", {
    request: {
      sessionId,
      requestId: "web-composed-continuation",
      content: [{ type: "text", text: "Continue after composed compaction." }],
      mode: "queue",
    },
  });
  await waitForRequests(beforeCompaction + 2);
  await waitForAssistant(`Web composed reply ${beforeCompaction + 2}`);
  assert.equal(
    providerRequests.at(-1)?.body?.client_metadata?.thread_id,
    normalizedId,
  );
  console.log(
    JSON.stringify(
      {
        webComposed: true,
        standardPreset: true,
        customCompaction: true,
        continuation: true,
        websocketUpgradeAttempts: upgradeCount,
        providerRequests: providerRequests.length,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  if (sessionFollow) await sessionFollow.close();
  if (runtime) await stopRuntime(runtime);
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
