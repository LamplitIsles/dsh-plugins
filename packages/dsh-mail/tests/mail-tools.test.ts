import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { RuntimeOptions, ServerDefinition } from "mcporter";
import {
  createMailToolDefinitions,
  MAIL_LIST,
  MAIL_READ,
  MAIL_READ_THREAD,
  MAIL_REPLY,
  MAIL_SEARCH,
  MAIL_SEND,
  MAIL_TOOL_NAMES,
} from "../src/mail-tools.js";
import { MailService } from "../src/index.js";
import { resolveMailConfig } from "../src/config.js";
import {
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  GUION_MCP_ENDPOINT,
  OAUTH_REDIRECT_URI,
} from "../src/constants.js";

function execution(): ToolRunContext {
  return { signal: new AbortController().signal } as ToolRunContext;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined, fallback: string): string {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  return fallback;
}

describe("mail tool projections", () => {
  it("registers exactly six closed model capabilities and fixes the mailbox upstream", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const tools = createMailToolDefinitions({
      call: async (tool, args) => {
        calls.push({ tool, args });
        return { messages: [{ id: "m-1" }], access_token: "never-return-this" };
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([...MAIL_TOOL_NAMES]);
    expect(tools).toHaveLength(6);
    const serializedSchemas = JSON.stringify(
      tools.map((tool) => tool.parameters),
    );
    expect(serializedSchemas).not.toMatch(/mailboxId|cc|bcc|replyAll/);

    await tools
      .find((tool) => tool.name === MAIL_LIST)!
      .execute({ folder: "INBOX", limit: 5, page: 2 }, execution());
    await tools
      .find((tool) => tool.name === MAIL_SEARCH)!
      .execute({ query: "invoice", folder: "INBOX" }, execution());
    await tools
      .find((tool) => tool.name === MAIL_READ)!
      .execute({ emailId: "m-1" }, execution());
    await tools
      .find((tool) => tool.name === MAIL_READ_THREAD)!
      .execute({ threadId: "t-1" }, execution());
    await tools
      .find((tool) => tool.name === MAIL_SEND)!
      .execute(
        { to: "person@example.com", subject: "Hi", bodyHtml: "<p>Hello</p>" },
        execution(),
      );
    await tools
      .find((tool) => tool.name === MAIL_REPLY)!
      .execute(
        {
          originalEmailId: "m-1",
          to: "person@example.com",
          subject: "Re: Hi",
          bodyHtml: "<p>Thanks</p>",
        },
        execution(),
      );

    expect(calls).toHaveLength(6);
    expect(calls.map(({ tool }) => tool)).toEqual([
      "list_emails",
      "search_emails",
      "get_email",
      "get_thread",
      "send_email",
      "send_reply",
    ]);
    expect(calls.map(({ args }) => args)).toEqual([
      { folder: "INBOX", limit: 5, page: 2 },
      { query: "invoice", folder: "INBOX" },
      { emailId: "m-1" },
      { threadId: "t-1" },
      { to: "person@example.com", subject: "Hi", bodyHtml: "<p>Hello</p>" },
      {
        originalEmailId: "m-1",
        to: "person@example.com",
        subject: "Re: Hi",
        bodyHtml: "<p>Thanks</p>",
      },
    ]);
    expect(calls.every(({ args }) => args.mailboxId === undefined)).toBe(true);
    const result = await tools[0]!.execute({ limit: 1 }, execution());
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  it("ignores a direct mailbox selector and returns a safe provider failure", async () => {
    const calls: Record<string, unknown>[] = [];
    const tools = createMailToolDefinitions({
      call: async (_tool, args) => {
        calls.push(args);
        throw new Error("provider included a bearer token and mailbox details");
      },
    });

    await expect(
      tools[0]!.execute(
        { limit: 1, mailboxId: "other@example.com" },
        execution(),
      ),
    ).rejects.toThrow("The upstream mail request failed.");
    expect(calls[0]).not.toHaveProperty("mailboxId");
  });

  it("fails before upstream work when the credential is absent", async () => {
    const service = new MailService({
      config: {},
      settings: () => ({
        mailboxAddress: "agent@example.com",
        upstreamEndpoint: GUION_MCP_ENDPOINT,
        oauthAuthorizationServer: DEFAULT_OAUTH_AUTHORIZATION_SERVER,
        oauthCallbackUrl: OAUTH_REDIRECT_URI,
      }),
      credentialStore: {
        read: async () => undefined,
        write: async () => undefined,
        clear: async () => undefined,
      },
      runtimeFactory: async () => {
        throw new Error("runtime must not start");
      },
    });

    await expect(
      service.call("list_emails", {}, new AbortController().signal),
    ).rejects.toThrow(
      "Mail is not connected. Connect the Agent mailbox from DSH Settings.",
    );
  });

  it("explains when the configured Agent mailbox is unavailable", async () => {
    const tools = createMailToolDefinitions({
      call: async () => {
        throw new Error("upstream-mailbox-not-found");
      },
    });

    await expect(tools[0]!.execute({ limit: 1 }, execution())).rejects.toThrow(
      "The configured Agent mailbox does not exist in the upstream mail service or is not available to this authorization. Check the mailbox address in DSH Settings.",
    );
  });

  it("uses the documented defaults for the upstream and OAuth connection", async () => {
    expect(resolveMailConfig({})).toMatchObject({
      upstreamEndpoint: GUION_MCP_ENDPOINT,
      oauthAuthorizationServer: DEFAULT_OAUTH_AUTHORIZATION_SERVER,
      oauthCallbackUrl: OAUTH_REDIRECT_URI,
    });

    let runtimeOptions: RuntimeOptions | undefined;
    let definition: ServerDefinition | undefined;
    const service = new MailService({
      config: {},
      settings: () => ({
        mailboxAddress: "agent@example.com",
        upstreamEndpoint: GUION_MCP_ENDPOINT,
        oauthAuthorizationServer: DEFAULT_OAUTH_AUTHORIZATION_SERVER,
        oauthCallbackUrl: OAUTH_REDIRECT_URI,
      }),
      credentialStore: {
        read: async () => ({
          kind: "grant" as const,
          payload: {
            accessToken: "access-1",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            tokenEndpoint: "https://mail.guion.io/token",
            clientId: "client-1",
            binding: JSON.stringify([
              GUION_MCP_ENDPOINT,
              DEFAULT_OAUTH_AUTHORIZATION_SERVER,
              OAUTH_REDIRECT_URI,
              undefined,
              undefined,
            ]),
          },
        }),
        write: async () => undefined,
        clear: async () => undefined,
      },
      runtimeFactory: async (options) => {
        runtimeOptions = options;
        return {
          registerDefinition(value) {
            definition = value;
          },
          callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
          close: async () => undefined,
        };
      },
    });

    await expect(
      service.call("list_emails", {}, new AbortController().signal),
    ).resolves.toEqual({});
    expect(runtimeOptions?.servers).toEqual([]);
    expect(definition?.command).toMatchObject({
      kind: "http",
      url: new URL(GUION_MCP_ENDPOINT),
    });
    await service.close();
  });

  it("routes a custom endpoint through OAuth and the capability-local MCP runtime", async () => {
    const endpoint = "https://mail.custom.test/mcp";
    const issuer = "https://auth.custom.test";
    const callback = "https://host.custom.test:9443/oauth/dsh-mail/callback";
    let grant: string | undefined;
    let runtimeOptions: RuntimeOptions | undefined;
    let definition: ServerDefinition | undefined;
    let call: { server: string; tool: string; args: unknown } | undefined;
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const service = new MailService({
      config: {},
      settings: () => ({
        mailboxAddress: "agent@example.com",
        upstreamEndpoint: endpoint,
        oauthAuthorizationServer: issuer,
        oauthCallbackUrl: callback,
      }),
      credentialStore: {
        read: async () =>
          grant
            ? { kind: "grant" as const, payload: JSON.parse(grant) }
            : undefined,
        write: async (_ref, value) => {
          grant = value;
        },
        clear: async () => {
          grant = undefined;
        },
      },
      fetcher: async (input, init) => {
        requests.push(
          init === undefined
            ? { input: requestUrl(input) }
            : { input: requestUrl(input), init },
        );
        const url = new URL(requestUrl(input));
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return new Response(
            JSON.stringify({
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              registration_endpoint: `${issuer}/register`,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (url.pathname === "/register") {
          return new Response(JSON.stringify({ client_id: "custom-client" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/token") {
          return new Response(
            JSON.stringify({ access_token: "custom-token", expires_in: 3600 }),
            { headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected request ${url}`);
      },
      runtimeFactory: async (options) => {
        runtimeOptions = options;
        return {
          registerDefinition(value) {
            definition = value;
          },
          callTool: async (server, tool, options) => {
            call = { server, tool, args: options?.args };
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            };
          },
          close: async () => undefined,
        };
      },
    });

    const start = await service.startAuthorization();
    expect(start.state).toBe("pending");
    const authorization = new URL(start.authorizationUrl!);
    expect(authorization.searchParams.get("redirect_uri")).toBe(callback);
    expect(authorization.searchParams.get("resource")).toBe(
      "https://mail.custom.test",
    );
    const registration = JSON.parse(requestBody(requests[1]?.init, "{}")) as {
      redirect_uris?: string[];
    };
    expect(registration.redirect_uris).toEqual([callback]);

    await expect(
      service.callback(
        new URLSearchParams({ state: start.attemptId!, code: "custom-code" }),
      ),
    ).resolves.toMatchObject({ state: "connected" });
    const tokenForm = new URLSearchParams(requestBody(requests[2]?.init, ""));
    expect(tokenForm.get("redirect_uri")).toBe(callback);
    expect(tokenForm.get("resource")).toBe("https://mail.custom.test");

    await expect(
      service.call(
        "list_emails",
        { mailboxId: "other@example.com" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ ok: true });
    expect(runtimeOptions?.servers).toEqual([]);
    expect(definition?.command).toMatchObject({
      kind: "http",
      url: new URL(endpoint),
    });
    expect(call).toEqual({
      server: "guion-email",
      tool: "list_emails",
      args: { mailboxId: "agent@example.com" },
    });
    await service.close();
  });
});
