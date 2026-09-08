import { describe, expect, it } from "vitest";
import { OAuthManager, parseOAuthGrant } from "../src/oauth.js";
import { OAUTH_REDIRECT_URI } from "../src/constants.js";

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 400,
    headers: { "content-type": "application/json" },
  });
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

function store() {
  let value: string | undefined;
  let writes = 0;
  return {
    get value() {
      return value;
    },
    get writes() {
      return writes;
    },
    credentialStore: {
      read: async () =>
        value
          ? { kind: "grant" as const, payload: JSON.parse(value) }
          : undefined,
      write: async (_ref: string, next: string) => {
        value = next;
        writes += 1;
      },
      clear: async () => {
        value = undefined;
      },
    },
  };
}

describe("Host-owned OAuth PKCE lifecycle", () => {
  it("does not reuse a grant issued for different saved connection settings", async () => {
    const saved = store();
    await saved.credentialStore.write(
      "grant",
      JSON.stringify({
        accessToken: "old-access",
        expiresAt: Date.now() + 3_600_000,
        tokenType: "Bearer",
        tokenEndpoint: "https://access.example/token",
        clientId: "client-1",
        binding: "old-connection",
      }),
    );
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.example/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
      },
      clientId: "client-1",
      grantBinding: "new-connection",
    });

    await expect(manager.accessToken()).rejects.toThrow(
      "Mail is not connected",
    );
  });

  it("stays pending while the callback token exchange is in flight", async () => {
    const saved = store();
    let completeExchange: ((response: Response) => void) | undefined;
    const exchange = new Promise<Response>((resolve) => {
      completeExchange = resolve;
    });
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
      },
      clientId: "client-1",
      fetcher: async () => await exchange,
    });

    const start = await manager.start();
    const callback = manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "code" }),
    );

    await expect(manager.status()).resolves.toMatchObject({ state: "pending" });

    completeExchange?.(
      response({ access_token: "access-1", expires_in: 3600 }),
    );
    await expect(callback).resolves.toMatchObject({ state: "connected" });
  });

  it("does not report a transient authorization failure for an overlapping callback replay", async () => {
    const saved = store();
    let completeExchange: ((response: Response) => void) | undefined;
    const exchange = new Promise<Response>((resolve) => {
      completeExchange = resolve;
    });
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
      },
      clientId: "client-1",
      fetcher: async () => await exchange,
    });

    const start = await manager.start();
    const firstCallback = manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "code" }),
    );
    const overlappingReplay = manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "code" }),
    );
    completeExchange?.(
      response({ access_token: "access-1", expires_in: 3600 }),
    );
    const [firstResult, replayResult] = await Promise.all([
      firstCallback,
      overlappingReplay,
    ]);

    expect(replayResult).toMatchObject({ state: "connected" });
    expect(firstResult).toMatchObject({ state: "connected" });
    expect(saved.writes).toBe(1);
  });

  it("uses dynamic registration, consumes state once, stores a grant, and refreshes it", async () => {
    let now = 1_700_000_000_000;
    const saved = store();
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
        registration_endpoint: "https://access.example/register",
      },
      redirectUri: OAUTH_REDIRECT_URI,
      now: () => now,
      fetcher: async (input, init) => {
        requests.push(
          init === undefined
            ? { input: requestUrl(input) }
            : { input: requestUrl(input), init },
        );
        if (requestUrl(input).endsWith("/register"))
          return response({ client_id: "client-1" });
        if (requestUrl(input).endsWith("/token")) {
          const form = new URLSearchParams(requestBody(init, ""));
          if (form.get("grant_type") === "authorization_code")
            return response({
              access_token: "access-1",
              refresh_token: "refresh-1",
              expires_in: 30,
            });
          return response({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          });
        }
        throw new Error("unexpected request");
      },
    });

    const start = await manager.start();
    expect(start.state).toBe("pending");
    expect(start.authorizationUrl).toBeTruthy();
    const authorization = new URL(start.authorizationUrl!);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      OAUTH_REDIRECT_URI,
    );
    expect(authorization.searchParams.get("resource")).toBe(
      "https://mail.guion.io",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("client_id")).toBe("client-1");
    expect(requests[0]?.init?.method).toBe("POST");

    const invalid = await manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "bad" }),
    );
    expect(invalid.state).toBe("connected");
    expect(saved.writes).toBe(1);
    const authorizationCodeForm = new URLSearchParams(
      requestBody(requests[1]?.init, ""),
    );
    expect(authorizationCodeForm.get("resource")).toBe("https://mail.guion.io");
    // The callback above was valid; a replay is rejected without another write.
    const replay = await manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "bad" }),
    );
    expect(replay.state).toBe("failed");
    expect(saved.writes).toBe(1);
    expect(parseOAuthGrant(saved.value)?.accessToken).toBe("access-1");

    now += 29_500;
    await expect(manager.accessToken()).resolves.toBe("access-2");
    expect(parseOAuthGrant(saved.value)?.refreshToken).toBe("refresh-2");
    const refreshForm = new URLSearchParams(requestBody(requests[2]?.init, ""));
    expect(refreshForm.get("resource")).toBe("https://mail.guion.io");
  });

  it("uses a configured issuer and callback for discovery, registration, authorization, and token exchange", async () => {
    const resourceEndpoint = "https://mail.custom.test/mcp";
    const authorizationServer = "https://identity.custom.test/tenant";
    const redirectUri = "https://host.custom.test:8443/oauth/dsh-mail/callback";
    const saved = store();
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint,
      authorizationServer,
      redirectUri,
      fetcher: async (input, init) => {
        requests.push(
          init === undefined
            ? { input: requestUrl(input) }
            : { input: requestUrl(input), init },
        );
        const url = new URL(requestUrl(input));
        if (url.pathname === "/.well-known/oauth-authorization-server/tenant") {
          return response({
            authorization_endpoint: `${authorizationServer}/authorize`,
            token_endpoint: `${authorizationServer}/token`,
            registration_endpoint: `${authorizationServer}/register`,
          });
        }
        if (url.pathname === "/tenant/register")
          return response({ client_id: "custom-client" });
        if (url.pathname === "/tenant/token")
          return response({ access_token: "custom-access", expires_in: 3600 });
        throw new Error(`unexpected request ${url}`);
      },
    });

    const start = await manager.start();
    expect(requests[0]?.input).toBe(
      `${new URL(authorizationServer).origin}/.well-known/oauth-authorization-server/tenant`,
    );
    const registration = JSON.parse(requestBody(requests[1]?.init, "{}")) as {
      redirect_uris?: string[];
    };
    expect(registration.redirect_uris).toEqual([redirectUri]);
    const authorization = new URL(start.authorizationUrl!);
    expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorization.searchParams.get("resource")).toBe(
      "https://mail.custom.test",
    );

    await expect(
      manager.callback(
        new URLSearchParams({ state: start.attemptId!, code: "custom-code" }),
      ),
    ).resolves.toMatchObject({ state: "connected" });
    const tokenForm = new URLSearchParams(requestBody(requests[2]?.init, ""));
    expect(tokenForm.get("redirect_uri")).toBe(redirectUri);
    expect(tokenForm.get("resource")).toBe("https://mail.custom.test");
  });

  it("uses the path-aware OIDC well-known URL when OAuth metadata is unavailable", async () => {
    const authorizationServer = "https://identity.custom.test/tenant";
    const saved = store();
    const requests: string[] = [];
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.custom.test/mcp",
      authorizationServer,
      fetcher: async (input) => {
        requests.push(requestUrl(input));
        const url = new URL(requestUrl(input));
        if (url.pathname === "/.well-known/oauth-authorization-server/tenant")
          return response({}, false);
        if (url.pathname === "/.well-known/openid-configuration/tenant") {
          return response({
            authorization_endpoint: `${authorizationServer}/authorize`,
            token_endpoint: `${authorizationServer}/token`,
            registration_endpoint: `${authorizationServer}/register`,
          });
        }
        if (url.pathname === "/tenant/register")
          return response({ client_id: "oidc-client" });
        throw new Error(`unexpected request ${url}`);
      },
    });

    await expect(manager.start()).resolves.toMatchObject({ state: "pending" });
    expect(requests.slice(0, 2)).toEqual([
      "https://identity.custom.test/.well-known/oauth-authorization-server/tenant",
      "https://identity.custom.test/.well-known/openid-configuration/tenant",
    ]);
  });

  it("does not store invalid, cancelled, or expired callbacks", async () => {
    let now = 1_700_000_000_000;
    const saved = store();
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
      },
      clientId: "client-1",
      now: () => now,
      fetcher: async () => response({ access_token: "should-not-store" }),
    });

    const invalidStart = await manager.start();
    const denied = await manager.callback(
      new URLSearchParams({
        state: invalidStart.attemptId!,
        error: "access_denied",
      }),
    );
    expect(denied.state).toBe("failed");
    expect(denied.message).toBe(
      "Cloudflare Access rejected authorization (access_denied). Retry from DSH Settings.",
    );
    expect(saved.writes).toBe(0);

    const cancelledStart = await manager.start();
    expect(manager.cancel(cancelledStart.attemptId).state).toBe("cancelled");
    expect(
      (
        await manager.callback(
          new URLSearchParams({
            state: cancelledStart.attemptId!,
            code: "late",
          }),
        )
      ).state,
    ).toBe("failed");
    expect(saved.writes).toBe(0);

    const expiredStart = await manager.start();
    now += 5 * 60_000 + 1;
    expect(
      (
        await manager.callback(
          new URLSearchParams({ state: expiredStart.attemptId!, code: "late" }),
        )
      ).state,
    ).toBe("failed");
    expect(saved.writes).toBe(0);
  });

  it("reports a safe token-exchange rejection without storing a grant", async () => {
    const saved = store();
    const manager = new OAuthManager({
      credentialStore: saved.credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
      },
      clientId: "client-1",
      fetcher: async () => response({ error: "redacted" }, false),
    });
    const start = await manager.start();
    const result = await manager.callback(
      new URLSearchParams({ state: start.attemptId!, code: "code" }),
    );
    expect(result.message).toBe(
      "Cloudflare Access rejected the token exchange (HTTP 400). Retry from DSH Settings.",
    );
    expect(saved.writes).toBe(0);
  });

  it("identifies a safe authorization setup stage", async () => {
    const manager = new OAuthManager({
      credentialStore: store().credentialStore,
      resourceEndpoint: "https://mail.guion.io/mcp",
      metadata: {
        authorization_endpoint: "https://access.example/authorize",
        token_endpoint: "https://access.example/token",
        registration_endpoint: "https://access.example/register",
      },
      fetcher: async () => {
        throw new Error("provider detail must not surface");
      },
    });

    await expect(manager.start()).resolves.toMatchObject({
      state: "failed",
      message:
        "Mail authorization setup failed during client registration. Retry from DSH Settings.",
    });
  });
});
