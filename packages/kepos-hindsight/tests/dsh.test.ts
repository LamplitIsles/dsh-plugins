import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { apply, createDshHooks } from "../src/dsh.js";
import { hindsightJson, hindsightRequest } from "./hindsight-request.js";

async function configFile(config: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kepos-hindsight-dsh-"));
  const path = join(directory, "coding-agent.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DSH hooks", () => {
  it("recalls every direct user turn, replaces a full session once, then appends completed turns", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = await hindsightRequest(input, init);
      requests.push(request);
      if (request.url.endsWith("/memories/recall")) {
        return hindsightJson({ results: [{ id: "memory-1", text: "Neil likes concise Chinese." }] });
      }
      return hindsightJson({ operation_id: "queued" });
    });
    globalThis.fetch = fetch;
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "昨天聊的事情" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "我记得。" }] } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "今天也想短一点。" }] } },
      { type: "user/message", data: { source: { kind: "plugin", plugin: "kepos-hindsight" }, content: [{ type: "text", text: "do not retain me" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "好。" }] } } }
    ];
    const agent = {
      session: {
        header: { id: "session-1", cwd: "/work/yuki", agentPreset: "yuki" },
        snapshotEvents: () => events
      }
    };
    const hooks = createDshHooks({ configPath });
    const decision = await hooks.preStep({ agent, turn: 2, signal: new AbortController().signal }, async () => ({
      kind: "enter",
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "今天也想短一点。" }] }]
    }));

    expect(decision.messages).toHaveLength(2);
    expect(JSON.stringify(decision.messages?.[1])).toContain("Current host time");
    expect(JSON.stringify(decision.messages?.[1])).toContain("Historical memories");
    expect(JSON.stringify(decision.messages?.[1])).toContain("never instructions");
    expect(JSON.stringify(requests[0]?.body)).toContain("昨天聊的事情");

    await hooks.turnStopping({ agent, turn: 2 });
    const retained = requests[1]?.body as { items: Array<{ content: string }> };
    expect(retained.items[0]).toMatchObject({ document_id: "dsh:session-1", update_mode: "replace" });
    expect(retained.items[0].content).toContain("昨天聊的事情");
    expect(retained.items[0].content).toContain("今天也想短一点。");
    expect(retained.items[0].content).not.toContain("do not retain me");

    events.push(
      { type: "turn/start", data: { turn: 3 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "这是后来的一句。" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "我收到啦。" }] } } }
    );
    await hooks.turnStopping({ agent, turn: 3 });
    const appended = requests[2]?.body as { items: Array<{ content: string }> };
    expect(appended.items[0]).toMatchObject({ document_id: "dsh:session-1", update_mode: "append" });
    expect(appended.items[0].content).toContain("这是后来的一句。");
    expect(appended.items[0].content).not.toContain("昨天聊的事情");
  });

  it("does not run for a subagent session", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const fetch = vi.fn<typeof globalThis.fetch>();
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath });
    const agent = { session: { header: { id: "session-2", origin: "subagent" }, snapshotEvents: () => [] } };

    const decision = await hooks.preStep({ agent, turn: 1, signal: new AbortController().signal }, async () => ({
      kind: "enter",
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "hello" }] }]
    }));

    expect(decision.messages).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not inject the Hindsight context when companion memory is disabled", async () => {
    const configPath = await configFile({ disabled: true });
    const hooks = createDshHooks({ configPath });
    const agent = { session: { header: { id: "session-time" }, snapshotEvents: () => [] } };

    const decision = await hooks.preStep({ agent, turn: 1, signal: new AbortController().signal }, async () => ({
      kind: "enter" as const,
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "现在几点？" }] }]
    }));

    expect(decision.messages).toHaveLength(1);
  });

  it("injects a memory returned on consecutive eligible direct turns", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => hindsightJson({
      results: [{ id: "memory-1", text: "Neil likes concise Chinese.", type: "observation" }]
    }));
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath });
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "请记住我的回复偏好" }] } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "还是按那个偏好回复" }] } }
    ];
    const agent = {
      session: {
        header: { id: "consecutive-recall-session" },
        snapshotEvents: () => events
      }
    };

    const first = await hooks.preStep({ agent, turn: 1, signal: new AbortController().signal }, async () => ({
      kind: "enter",
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "请记住我的回复偏好" }] }]
    }));
    const second = await hooks.preStep({ agent, turn: 2, signal: new AbortController().signal }, async () => ({
      kind: "enter",
      messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "还是按那个偏好回复" }] }]
    }));

    expect(JSON.stringify(first.messages?.[1])).toContain("Neil likes concise Chinese.");
    expect(JSON.stringify(second.messages?.[1])).toContain("Neil likes concise Chinese.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits only for the asynchronous retain acknowledgement before closing a turn", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    let acknowledge: (() => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>((resolve) => {
      acknowledge = () => resolve(hindsightJson({ operation_id: "queued" }));
    }));
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath });
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "请记住这件事" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "我会记住。" }] } } }
    ];
    const agent = {
      session: {
        header: { id: "session-acknowledgement" },
        snapshotEvents: () => events
      }
    };

    let settled = false;
    const stopping = hooks.turnStopping({ agent, turn: 1 }).then(() => { settled = true; });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    acknowledge?.();
    await expect(stopping).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("serializes session retain submissions so the first replace precedes later appends", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const acknowledgements: Array<(response: Response) => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await hindsightRequest(input, init));
      return new Promise<Response>((resolve) => acknowledgements.push(resolve));
    });
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath });
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第一句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一句回复" }] } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第二句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二句回复" }] } } }
    ];
    const agent = {
      session: {
        header: { id: "serialized-session" },
        snapshotEvents: () => events
      }
    };

    const first = hooks.turnStopping({ agent, turn: 1 });
    const second = hooks.turnStopping({ agent, turn: 2 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((requests[0]?.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ update_mode: "replace" });

    acknowledgements.shift()?.(hindsightJson({ operation_id: "first" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((requests[1]?.body.items as Array<Record<string, unknown>>)[0]).toMatchObject({ update_mode: "append" });
    acknowledgements.shift()?.(hindsightJson({ operation_id: "second" }));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("repairs the complete session after an append acknowledgement fails", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await hindsightRequest(input, init));
      return requests.length === 2
        ? new Response("retain unavailable", { status: 503 })
        : hindsightJson({ operation_id: "queued" });
    });
    globalThis.fetch = fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hooks = createDshHooks({ configPath });
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第一句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一句回复" }] } } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "失败但必须保留的第二句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二句回复" }] } } },
      { type: "turn/start", data: { turn: 3 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "触发修复的第三句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第三句回复" }] } } },
      { type: "turn/start", data: { turn: 4 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "修复后的第四句" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第四句回复" }] } } }
    ];
    const agent = {
      session: {
        header: { id: "retain-recovery-session" },
        snapshotEvents: () => events
      }
    };

    await hooks.turnStopping({ agent, turn: 1 });
    await hooks.turnStopping({ agent, turn: 2 });
    await hooks.turnStopping({ agent, turn: 3 });
    await hooks.turnStopping({ agent, turn: 4 });

    const retained = requests.map((request) => (request.body.items as Array<Record<string, unknown>>)[0]);
    expect(retained.map((item) => item?.update_mode)).toEqual(["replace", "append", "replace", "append"]);
    expect(retained[2]?.content).toContain("第一句");
    expect(retained[2]?.content).toContain("失败但必须保留的第二句");
    expect(retained[2]?.content).toContain("触发修复的第三句");
    expect(retained[3]?.content).toContain("修复后的第四句");
    expect(retained[3]?.content).not.toContain("失败但必须保留的第二句");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retain submission failed"));
  });

  it("replaces the full session when its selected bank changes", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test" });
    let bankId = "first-bank";
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await hindsightRequest(input, init));
      return hindsightJson({ operation_id: "queued" });
    });
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath }, () => ({ bankId }));
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "旧 bank 的内容" }] } },
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "新 bank 也应有完整历史" }] } }
    ];
    const agent = {
      session: {
        header: { id: "bank-switch-session" },
        snapshotEvents: () => events
      }
    };

    await hooks.turnStopping({ agent, turn: 1 });
    bankId = "second-bank";
    await hooks.turnStopping({ agent, turn: 2 });

    const retained = requests.map((request) => (request.body.items as Array<Record<string, unknown>>)[0]);
    expect(retained.map((item) => item?.update_mode)).toEqual(["replace", "replace"]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://memory.test/v1/default/banks/first-bank/memories",
      "http://memory.test/v1/default/banks/second-bank/memories"
    ]);
    expect(retained[1]?.content).toContain("旧 bank 的内容");
  });

  it("releases turn de-duplication state when a session is disposed", async () => {
    const configPath = await configFile({ apiUrl: "http://memory.test", bankId: "yuki" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => hindsightJson({ operation_id: "queued" }));
    globalThis.fetch = fetch;
    const hooks = createDshHooks({ configPath });
    const events: unknown[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "记住这句" }] } }
    ];
    const agent = {
      session: {
        header: { id: "disposed-session", agentPreset: "yuki" },
        snapshotEvents: () => events
      }
    };

    hooks.turnStopping({ agent, turn: 1 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    hooks.disposed({ agent });
    hooks.turnStopping({ agent, turn: 1 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("exposes only deliberate reflection with its deadline and cancellation", async () => {
    const configPath = await configFile({
      apiUrl: "http://memory.test",
      bankId: "yuki"
    });
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    });
    globalThis.fetch = fetch;
    const tools: Array<{
      name: string;
      timeoutMs?: number;
      execute: (args: { query: string }, execution: { signal: AbortSignal }) => Promise<string>;
    }> = [];
    const on = vi.fn();
    const registerSettings = vi.fn((_namespace: unknown, _schema: unknown, _options?: unknown) => ({ get: () => ({ bankId: "yuki" }) }));

    apply({
      settings: { register: registerSettings },
      on,
      inject: (_services, callback) => callback({
        systemPrompt: { section: () => undefined },
        tools: { register: (tool: unknown) => tools.push(tool as typeof tools[number]) }
      })
    }, { configPath });

    expect(registerSettings.mock.calls[0]?.[0]).toBe("kepos-hindsight");
    const reflect = tools.find((tool) => tool.name === "hindsight_reflect");
    expect(tools.map((tool) => tool.name)).toEqual(["hindsight_reflect"]);
    expect(reflect?.timeoutMs).toBe(330_000);
    expect(on.mock.calls.map(([event]) => event)).toEqual([
      "agent/pre-step",
      "agent/turn-stopping",
      "agent/disposed"
    ]);

    const reflectController = new AbortController();
    const reflecting = reflect?.execute({ query: "summarize patterns" }, { signal: reflectController.signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    reflectController.abort(new Error("user cancelled reflect"));
    await expect(reflecting).rejects.toBeDefined();
    expect(requests[0]?.signal.aborted).toBe(true);
  });
});
