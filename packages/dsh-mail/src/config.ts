import { isIP } from "node:net";
import {
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  GUION_MCP_ENDPOINT,
  OAUTH_CALLBACK_PATH,
  OAUTH_REDIRECT_URI,
  type MailConnectionConfig
} from "./constants.js";

/** The configuration after optional profile values have received defaults. */
export interface ResolvedMailConfig extends MailConnectionConfig {
  readonly upstreamEndpoint: string;
  readonly oauthAuthorizationServer: string;
  readonly oauthCallbackUrl: string;
}

/**
 * Validate an absolute HTTPS URL used for a network service. The returned
 * value is kept as authored so OAuth registration and transport use the same
 * profile value.
 */
export function validateHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL.`);
  }
  return value;
}

/** Validate an OAuth issuer, which cannot contain query or fragment data. */
export function validateOAuthAuthorizationServerUrl(value: unknown, field = "oauthAuthorizationServer"): string {
  const validated = validateHttpsUrl(value, field);
  if (new URL(validated).search) {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL without a query or fragment.`);
  }
  return validated;
}

/** Validate a callback URL without allowing non-loopback HTTP navigation. */
export function validateOAuthCallbackUrl(value: unknown, field = "oauthCallbackUrl"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL or an HTTP loopback URL.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL or an HTTP loopback URL.`);
  }
  const safeHttps = url.protocol === "https:" && Boolean(url.hostname);
  const safeHttpLoopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if ((!safeHttps && !safeHttpLoopback) || url.username || url.password || url.hash || url.pathname !== OAUTH_CALLBACK_PATH) {
    throw new Error(`dsh-mail ${field} must be an absolute HTTPS URL or an HTTP loopback URL.`);
  }
  return value;
}

/** Resolve and validate all operator-controlled connection infrastructure. */
export function resolveMailConfig(config: MailConnectionConfig | null | undefined = {}): ResolvedMailConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("dsh-mail configuration must be an object.");
  }
  const upstreamEndpoint = validateHttpsUrl(config.upstreamEndpoint ?? GUION_MCP_ENDPOINT, "upstreamEndpoint");
  const oauthAuthorizationServer = validateOAuthAuthorizationServerUrl(
    config.oauthAuthorizationServer ?? DEFAULT_OAUTH_AUTHORIZATION_SERVER,
    "oauthAuthorizationServer"
  );
  const oauthCallbackUrl = validateOAuthCallbackUrl(config.oauthCallbackUrl ?? OAUTH_REDIRECT_URI);
  return {
    ...config,
    upstreamEndpoint,
    oauthAuthorizationServer,
    oauthCallbackUrl
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost") return true;
  const addressType = isIP(host);
  if (addressType === 4) return host.split(".")[0] === "127";
  return addressType === 6 && host === "::1";
}
