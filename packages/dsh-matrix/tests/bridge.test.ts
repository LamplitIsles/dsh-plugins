import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { MatrixBridge, bridgeRpcHandler, type BridgeAgent, type BridgeDependencies } from "../src/bridge.js";
import type { MatrixEventLike, MatrixRoomLike } from "../src/matrix-protocol.js";
import { MATRIX_LIST_MEMBERS, MATRIX_READ_RECENT_MESSAGES, MATRIX_SEND_MESSAGE, MATRIX_SEND_FILE } from "../src/matrix-tools.js";

class FakeClient extends EventEmitter {
  readonly sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  stopped = false;
  startClient() {}
  async stopClient() { this.stopped = true; }
  async sendMessage(roomId: string, content: Record<string, unknown>) { this.sent.push({ roomId, content }); }
  getRoom(): MatrixRoomLike | undefined { return undefined; }
  async fetchRoomEvent(_roomId: string, _eventId: string, _signal?: AbortSignal): Promise<MatrixEventLike> { throw new Error("not found"); }
}

function baseDeps(client: FakeClient, agent?: BridgeAgent): BridgeDependencies {
  return {
    getSettings: () => ({ homeserverUrl: "https://matrix.example", userId: "@bot:example", roomId: "!allowed:example", workspaceId: "workspace", respondToAll: false }),
    resolveCredential: async () => ({ value: "secret-token" }),
    workspaceRegistry: { get: () => ({ id: "workspace", sessionIds: ["session"] }), archivedSessionIds: new Set() },
    inspectSession: async () => ({ meta: { id: "session", agentPreset: "default" }, events: [{ type: "user/message", time: 1, data: { source: { kind: "user" } } }] }),
    resolveAgent: async () => agent ? { agent } : { error: new Error("agent unavailable") },
    matrixClientFactory: async () => client
  };
}

function matrixEvent(id: string, body: string, sender = "@human:example") {
  return { getType: () => "m.room.message", getRoomId: () => "!allowed:example", getSender: () => sender, getId: () => id, getContent: () => ({ msgtype: "m.text", body, "m.mentions": { user_ids: ["@bot:example"] } }) };
}

describe("MatrixBridge", () => {
  it("resolves the selected conversation once through the shared controller", async () => {
    const client = new FakeClient();
    const agent: BridgeAgent = { id: "newer" as never, followup: () => undefined, whenIdle: async () => undefined };
    const dependencies = baseDeps(client, agent);
    dependencies.workspaceRegistry = { get: () => ({ id: "workspace", sessionIds: ["older", "newer"] }), archivedSessionIds: new Set() };
    dependencies.inspectSession = async (sessionId) => ({ meta: { id: sessionId }, events: [{ type: "user/message", time: sessionId === "newer" ? 2 : 1, data: { source: { kind: "user" } } }] });
    const resolvedSessionIds: string[] = [];
    dependencies.resolveAgent = async (sessionId) => { resolvedSessionIds.push(sessionId); return { agent }; };
    const bridge = new MatrixBridge(dependencies);

    await Promise.all([bridge.start(), bridge.start()]);

    expect(resolvedSessionIds).toEqual(["newer"]);
    expect(bridge.agent).toBe(agent);
    await bridge.stop();
  });

  it("does not start Matrix when shared Agent resolution fails", async () => {
    const client = new FakeClient();
    const dependencies = baseDeps(client);
    let matrixStarts = 0;
    dependencies.matrixClientFactory = async () => { matrixStarts += 1; return client; };
    const bridge = new MatrixBridge(dependencies);

    await bridge.start();

    expect(bridge.readiness).toMatchObject({ state: "failed", sessionId: "session" });
    expect(matrixStarts).toBe(0);
    expect(bridge.matrixClient).toBeUndefined();
    await bridge.stop();
  });

  it("registers only the active Companion's four fixed-target tools and scoped policy", async () => {
    const client = new FakeClient();
    const registered: ToolDefinition[] = [];
    const disposed: string[] = [];
    const agent: BridgeAgent = { id: "session" as never, ctx: { tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => disposed.push(tool.name); } }, systemPrompt: { section: (section: { name: string }) => { disposed.push(`policy:${section.name}`); return () => undefined; } } } as never, followup: () => undefined, whenIdle: async () => undefined };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    expect(registered.map((tool) => tool.name)).toEqual([MATRIX_LIST_MEMBERS, MATRIX_READ_RECENT_MESSAGES, MATRIX_SEND_MESSAGE, MATRIX_SEND_FILE]);
    client.emit("sync", "PREPARED");
    await registered[2]!.execute({ body: "hello" }, { signal: new AbortController().signal } as never);
    expect(client.sent[0]).toMatchObject({ roomId: "!allowed:example", content: { body: "hello" } });
    await bridge.stop();
    expect(disposed).toContain("matrix_send_message");
    expect(disposed).toContain("matrix_send_file");
    expect(disposed).toContain("policy:dsh-matrix:companion-policy");
  });

  it("does not relay a final Assistant text without an explicit send call", async () => {
    const client = new FakeClient();
    const prompts: UserMessage[] = [];
    const agent: BridgeAgent = { id: "session" as never, followup: (message) => { prompts.push(message as UserMessage); }, whenIdle: async () => undefined };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$trigger", "@bot:example answer"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toHaveLength(1);
    expect(client.sent).toHaveLength(0);
    await bridge.stop();
  });

  it("allows the Agent to reply to verified room history from any turn", async () => {
    const client = new FakeClient();
    client.fetchRoomEvent = async (_roomId, eventId) => matrixEvent(eventId, "earlier");
    const registered: ToolDefinition[] = [];
    const agent: BridgeAgent = { id: "session" as never, ctx: { tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => undefined; } } } as never, followup: async (message) => {
      void message;
      const send = registered.find((tool) => tool.name === MATRIX_SEND_MESSAGE)!;
      await send.execute({ body: "reply", replyToEventId: "$older" }, { signal: new AbortController().signal } as never);
    }, whenIdle: async () => undefined };
    const bridge = new MatrixBridge(baseDeps(client, agent));
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$trigger", "@bot:example answer"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.sent).toEqual([{ roomId: "!allowed:example", content: { msgtype: "m.text", body: "reply", "m.relates_to": { "m.in_reply_to": { event_id: "$older" } } } }]);
    await bridge.stop();
  });

  it("does not emit an automatic unbound-room notice", async () => {
    const client = new FakeClient();
    const dependencies = baseDeps(client);
    dependencies.workspaceRegistry = { get: () => ({ id: "workspace", sessionIds: [] }), archivedSessionIds: new Set() };
    const bridge = new MatrixBridge(dependencies);
    await bridge.start();
    client.emit("sync", "PREPARED");
    client.emit("Room.timeline", matrixEvent("$trigger", "@bot:example answer"), {}, false, false, { timeline: "live" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.readiness.state).toBe("unbound");
    expect(client.sent).toHaveLength(0);
    await bridge.stop();
  });

  it("serves bounded readiness through the package RPC", async () => {
    const bridge = new MatrixBridge(baseDeps(new FakeClient()));
    const handler = bridgeRpcHandler(bridge);
    await expect(handler("unknown", {}, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});
