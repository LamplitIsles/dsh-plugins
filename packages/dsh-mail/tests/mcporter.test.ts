import { describe, expect, it } from "vitest";
import { GuionMcpClient } from "../src/mcporter.js";

function fakeRuntime(call: () => Promise<unknown>) {
  const registrations: unknown[] = [];
  const closed: (string | undefined)[] = [];
  return {
    registrations,
    closed,
    runtime: {
      registerDefinition(definition: unknown) { registrations.push(definition); },
      callTool: async () => await call(),
      close: async (server?: string) => { closed.push(server); }
    }
  };
}

describe("capability-local MCPorter client", () => {
  it("starts with no ambient servers and registers only the Guion mail tool allowlist", async () => {
    let runtimeOptions: unknown;
    const fake = fakeRuntime(async () => ({ content: [{ type: "text", text: JSON.stringify({ messages: [{ id: "m-1" }] }) }] }));
    const client = new GuionMcpClient({
      runtimeFactory: async (options) => {
        runtimeOptions = options;
        return fake.runtime;
      }
    });

    await expect(client.call("list_emails", { mailboxId: "agent@example.com" }, "access-token")).resolves.toEqual({ messages: [{ id: "m-1" }] });
    expect(runtimeOptions).toMatchObject({ servers: [] });
    expect(fake.registrations).toHaveLength(1);
    expect(fake.registrations[0]).toMatchObject({
      name: "guion-email",
      command: {
        kind: "http",
        url: new URL("https://mail.guion.io/mcp"),
        headers: { authorization: "Bearer access-token" }
      },
      allowedTools: ["list_emails", "search_emails", "get_email", "get_thread", "send_email", "send_reply"]
    });
    await client.close();
    expect(fake.closed).toContain(undefined);
  });

  it("replaces the server definition for a refreshed token and closes on cancellation", async () => {
    let resolveCall: ((value: unknown) => void) | undefined;
    let callCount = 0;
    const fake = fakeRuntime(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve({ content: [{ type: "text", text: "{}" }] });
      return new Promise((resolve) => { resolveCall = resolve; });
    });
    const client = new GuionMcpClient({ runtimeFactory: async () => fake.runtime });
    await client.call("list_emails", {}, "token-1");
    const controller = new AbortController();
    const pending = client.call("search_emails", {}, "token-2", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("mail-call-cancelled");
    expect(fake.closed).toContain("guion-email");
    resolveCall?.({ content: [{ type: "text", text: "{}" }] });
    await client.close();
  });

  it("classifies an upstream authorization rejection without passing through details", async () => {
    const fake = fakeRuntime(async () => ({ isError: true, content: [{ type: "text", text: "401 Unauthorized: secret provider details" }] }));
    const client = new GuionMcpClient({ runtimeFactory: async () => fake.runtime });
    await expect(client.call("get_email", { emailId: "m" }, "token")).rejects.toThrow("upstream-auth-rejected");
  });

  it("classifies a missing configured mailbox without passing through provider details", async () => {
    const fake = fakeRuntime(async () => ({ isError: true, content: [{ type: "text", text: "Mailbox agent@example.com not found" }] }));
    const client = new GuionMcpClient({ runtimeFactory: async () => fake.runtime });
    await expect(client.call("list_emails", { mailboxId: "agent@example.com" }, "token")).rejects.toThrow("upstream-mailbox-not-found");
  });
});
