import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  GUION_MCP_ENDPOINT,
  OAUTH_REDIRECT_URI
} from "../src/constants.js";
import { resolveMailConfig } from "../src/config.js";
import { validateMailboxSetting } from "../src/settings.js";

describe("mail upstream configuration", () => {
  it("resolves the Guion defaults and accepts a configured HTTPS deployment", () => {
    expect(resolveMailConfig()).toMatchObject({
      upstreamEndpoint: GUION_MCP_ENDPOINT,
      oauthAuthorizationServer: DEFAULT_OAUTH_AUTHORIZATION_SERVER,
      oauthCallbackUrl: OAUTH_REDIRECT_URI
    });
    expect(resolveMailConfig({
      upstreamEndpoint: "https://mail.example.test/mcp",
      oauthAuthorizationServer: "https://login.example.test/issuer",
      oauthCallbackUrl: "https://host.example.test:8443/oauth/dsh-mail/callback"
    })).toMatchObject({
      upstreamEndpoint: "https://mail.example.test/mcp",
      oauthAuthorizationServer: "https://login.example.test/issuer",
      oauthCallbackUrl: "https://host.example.test:8443/oauth/dsh-mail/callback"
    });
  });

  it("allows only safe endpoint, issuer, and callback URL forms", () => {
    expect(() => resolveMailConfig({ upstreamEndpoint: "http://mail.example.test/mcp" })).toThrow(
      "dsh-mail upstreamEndpoint must be an absolute HTTPS URL."
    );
    expect(() => resolveMailConfig({ upstreamEndpoint: "https://mail.example.test/mcp#fragment" })).toThrow(
      "dsh-mail upstreamEndpoint must be an absolute HTTPS URL."
    );
    expect(() => resolveMailConfig({ oauthAuthorizationServer: "ftp://login.example.test" })).toThrow(
      "dsh-mail oauthAuthorizationServer must be an absolute HTTPS URL."
    );
    expect(() => resolveMailConfig({ oauthAuthorizationServer: "https://login.example.test/tenant?region=one" })).toThrow(
      "dsh-mail oauthAuthorizationServer must be an absolute HTTPS URL without a query or fragment."
    );
    expect(() => resolveMailConfig({ oauthAuthorizationServer: "https://login.example.test/tenant#fragment" })).toThrow(
      "dsh-mail oauthAuthorizationServer must be an absolute HTTPS URL."
    );
    expect(() => resolveMailConfig({ oauthCallbackUrl: "http://host.example.test/oauth/callback" })).toThrow(
      "dsh-mail oauthCallbackUrl must be an absolute HTTPS URL or an HTTP loopback URL."
    );
    expect(() => resolveMailConfig({ oauthCallbackUrl: "https://host.example.test/oauth/other" })).toThrow(
      "dsh-mail oauthCallbackUrl must be an absolute HTTPS URL or an HTTP loopback URL."
    );
    expect(() => resolveMailConfig({ oauthCallbackUrl: "http://127.0.0.1:3080/oauth/dsh-mail/callback#fragment" })).toThrow(
      "dsh-mail oauthCallbackUrl must be an absolute HTTPS URL or an HTTP loopback URL."
    );
    expect(() => resolveMailConfig({ oauthCallbackUrl: "http://127.0.0.2:3080/oauth/dsh-mail/callback" })).not.toThrow();
    expect(() => resolveMailConfig({ oauthCallbackUrl: "http://[::1]:3080/oauth/dsh-mail/callback" })).not.toThrow();
  });

  it("rejects malformed connection settings before they are persisted", () => {
    const settings = {
      mailboxAddress: "agent@example.com",
      upstreamEndpoint: "https://mail.example.test/mcp",
      oauthAuthorizationServer: "https://login.example.test",
      oauthCallbackUrl: "http://127.0.0.1:3080/oauth/dsh-mail/callback"
    };
    expect(() => validateMailboxSetting({ ...settings, upstreamEndpoint: "http://mail.example.test/mcp" })).toThrow();
    expect(() => validateMailboxSetting({ ...settings, oauthAuthorizationServer: "http://login.example.test" })).toThrow();
    expect(() => validateMailboxSetting({ ...settings, oauthCallbackUrl: "http://host.example.test/callback" })).toThrow();
  });
});
