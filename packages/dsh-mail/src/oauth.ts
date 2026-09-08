import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  CREDENTIAL_REF,
  DEFAULT_CLIENT_NAME,
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  OAUTH_ATTEMPT_TTL_MS,
  OAUTH_EXPIRY_SKEW_MS,
  OAUTH_REDIRECT_URI,
  type ConnectionStatus,
} from "./constants.js";
import {
  validateHttpsUrl,
  validateOAuthAuthorizationServerUrl,
  validateOAuthCallbackUrl,
} from "./config.js";

export interface CredentialGrantRecord {
  readonly kind: "grant";
  readonly payload: unknown;
}

export interface CredentialStore {
  read(key: string): Promise<CredentialGrantRecord | undefined>;
  write(key: string, value: string): Promise<unknown>;
  clear(key: string): Promise<unknown>;
}

export interface OAuthMetadata {
  readonly issuer?: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint?: string;
  readonly scopes_supported?: readonly string[];
}

export interface OAuthGrant {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly tokenType: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly binding?: string;
}

export interface OAuthAttempt {
  readonly id: string;
  readonly verifier: string;
  readonly metadata: OAuthMetadata;
  readonly clientId: string;
  readonly expiresAt: number;
}

export interface OAuthManagerOptions {
  readonly credentialStore: CredentialStore;
  readonly resourceEndpoint: string;
  readonly authorizationServer?: string;
  readonly scope?: string;
  readonly clientName?: string;
  readonly redirectUri?: string;
  readonly credentialRef?: string;
  /** Optional connection identity required for a reusable stored grant. */
  readonly grantBinding?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Test/deployment seam for a provider that already supplied metadata. */
  readonly metadata?: OAuthMetadata;
  /** Test/deployment seam for a provider with a pre-registered public client. */
  readonly clientId?: string;
}

export interface AuthorizationStart {
  readonly state: "pending" | "connected" | "failed";
  readonly authorizationUrl?: string;
  readonly attemptId?: string;
  readonly retryable?: boolean;
  readonly message?: string;
}

const SAFE_FAILURE =
  "Mail authorization failed. Check the registered callback URL and retry from DSH Settings.";
const SAFE_REFRESH_FAILURE =
  "Mail authorization expired. Retry from DSH Settings.";

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function challengeFor(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeOAuthErrorCode(value: string | undefined): string | undefined {
  return value && /^[a-z_]{1,64}$/u.test(value) ? value : undefined;
}

function safeError(): Error {
  return new Error(SAFE_FAILURE);
}

function safeRefreshError(): Error {
  return new Error(SAFE_REFRESH_FAILURE);
}

function credentialText(
  value: CredentialGrantRecord | undefined,
): string | undefined {
  if (!value || value.kind !== "grant") return undefined;
  try {
    return JSON.stringify(value.payload);
  } catch {
    return undefined;
  }
}

function parseGrant(value: string | undefined): OAuthGrant | undefined {
  if (!value) return undefined;
  try {
    const raw: unknown = JSON.parse(value);
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const accessToken = stringValue(record.accessToken);
    const tokenEndpoint = stringValue(record.tokenEndpoint);
    const clientId = stringValue(record.clientId);
    const expiresAt = record.expiresAt;
    if (
      !accessToken ||
      !tokenEndpoint ||
      !clientId ||
      !isSafeHttpsUrl(tokenEndpoint) ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    )
      return undefined;
    const refreshToken = stringValue(record.refreshToken);
    const scope = stringValue(record.scope);
    const binding = stringValue(record.binding);
    return {
      accessToken,
      expiresAt,
      tokenEndpoint,
      clientId,
      tokenType: stringValue(record.tokenType) ?? "Bearer",
      ...(refreshToken ? { refreshToken } : {}),
      ...(scope ? { scope } : {}),
      ...(binding ? { binding } : {}),
    };
  } catch {
    return undefined;
  }
}

function grantText(grant: OAuthGrant): string {
  return JSON.stringify(grant);
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isSafeAuthorizationServerUrl(value: unknown): value is string {
  if (!isSafeHttpsUrl(value)) return false;
  try {
    return new URL(value).search === "";
  } catch {
    return false;
  }
}

async function jsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok) throw safeError();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw safeError();
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw safeError();
  return body as Record<string, unknown>;
}

function metadataFrom(value: Record<string, unknown>): OAuthMetadata {
  const authorizationEndpoint = value.authorization_endpoint;
  const tokenEndpoint = value.token_endpoint;
  if (!isSafeHttpsUrl(authorizationEndpoint) || !isSafeHttpsUrl(tokenEndpoint))
    throw safeError();
  const registrationEndpoint = isSafeHttpsUrl(value.registration_endpoint)
    ? value.registration_endpoint
    : undefined;
  const scopes = Array.isArray(value.scopes_supported)
    ? value.scopes_supported.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    ...(isSafeAuthorizationServerUrl(value.issuer)
      ? { issuer: value.issuer }
      : {}),
    ...(registrationEndpoint
      ? { registration_endpoint: registrationEndpoint }
      : {}),
    ...(scopes ? { scopes_supported: scopes } : {}),
  };
}

export class OAuthManager {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly attempts = new Map<string, OAuthAttempt>();
  private readonly callbackExchanges = new Map<
    string,
    Promise<ConnectionStatus>
  >();
  private metadataPromise: Promise<OAuthMetadata> | undefined;
  private refreshPromise: Promise<OAuthGrant> | undefined;
  private lastStatus: ConnectionStatus = { state: "idle" };

  constructor(private readonly options: OAuthManagerOptions) {
    validateHttpsUrl(options.resourceEndpoint, "upstreamEndpoint");
    if (options.authorizationServer !== undefined)
      validateOAuthAuthorizationServerUrl(options.authorizationServer);
    if (options.redirectUri !== undefined)
      validateOAuthCallbackUrl(options.redirectUri);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? ((size) => nodeRandomBytes(size));
  }

  get credentialRef(): string {
    return this.options.credentialRef ?? CREDENTIAL_REF;
  }

  /** Start one browser authorization attempt and return only a URL/status. */
  async start(force = false): Promise<AuthorizationStart> {
    this.purgeExpired();
    if (force) await this.options.credentialStore.clear(this.credentialRef);
    if (await this.readGrant()) {
      this.lastStatus = { state: "connected" };
      return { state: "connected" };
    }
    for (const attempt of this.attempts.values())
      this.attempts.delete(attempt.id);
    let stage = "authorization metadata";
    try {
      const metadata = await this.metadata();
      stage = "client registration";
      const clientId = await this.registerClient(metadata);
      const verifier = base64Url(this.random(32));
      const state = base64Url(this.random(32));
      const expiresAt = this.now() + OAUTH_ATTEMPT_TTL_MS;
      const attempt: OAuthAttempt = {
        id: state,
        verifier,
        metadata,
        clientId,
        expiresAt,
      };
      this.attempts.set(state, attempt);
      const url = new URL(metadata.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", this.redirectUri());
      // Authorization servers can bind their authorization code to the
      // protected MCP resource. Omitting this standard target parameter may
      // yield invalid_target from the provider.
      url.searchParams.set(
        "resource",
        new URL(this.options.resourceEndpoint).origin,
      );
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challengeFor(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      const scope = this.options.scope ?? "";
      if (scope) url.searchParams.set("scope", scope);
      this.lastStatus = { state: "pending" };
      return {
        state: "pending",
        authorizationUrl: url.toString(),
        attemptId: state,
      };
    } catch {
      const message = `Mail authorization setup failed during ${stage}. Retry from DSH Settings.`;
      this.lastStatus = { state: "failed", retryable: true, message };
      return { state: "failed", retryable: true, message };
    }
  }

  /** Return a model-free connection status for the browser card. */
  async status(): Promise<ConnectionStatus> {
    this.purgeExpired();
    if (await this.readGrant()) return { state: "connected" };
    if (this.attempts.size > 0) return { state: "pending" };
    return this.lastStatus;
  }

  cancel(attemptId?: string): ConnectionStatus {
    if (attemptId) this.attempts.delete(attemptId);
    else this.attempts.clear();
    this.lastStatus = {
      state: "cancelled",
      retryable: true,
      message: "Mail authorization was cancelled.",
    };
    return this.lastStatus;
  }

  /** Complete a callback. Every state is consumed before code exchange. */
  async callback(
    params: URLSearchParams | Record<string, unknown>,
  ): Promise<ConnectionStatus> {
    this.purgeExpired();
    const read = (key: string): string | undefined =>
      params instanceof URLSearchParams
        ? (params.get(key) ?? undefined)
        : stringValue(params[key]);
    const state = read("state");
    const callbackExchange = state
      ? this.callbackExchanges.get(state)
      : undefined;
    if (callbackExchange) return await callbackExchange;
    const attempt = state ? this.attempts.get(state) : undefined;
    if (!attempt || attempt.expiresAt <= this.now()) {
      this.lastStatus = {
        state: "failed",
        retryable: true,
        message: this.safeFailureMessage(),
      };
      return this.lastStatus;
    }
    // Consume before any network work: callback replay can never exchange a code.
    this.attempts.delete(attempt.id);
    const oauthError = safeOAuthErrorCode(read("error"));
    if (oauthError || !read("code")) {
      this.lastStatus = {
        state: "failed",
        retryable: true,
        message: oauthError
          ? `${this.providerLabel()} rejected authorization (${oauthError}). Retry from DSH Settings.`
          : `${this.providerLabel()} did not issue an authorization code. Retry from DSH Settings.`,
      };
      return this.lastStatus;
    }
    const exchange = (async (): Promise<ConnectionStatus> => {
      try {
        const response = await this.fetcher(attempt.metadata.token_endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: read("code")!,
            client_id: attempt.clientId,
            redirect_uri: this.redirectUri(),
            code_verifier: attempt.verifier,
            resource: this.resourceOrigin(),
          }),
        });
        if (!response.ok) {
          this.lastStatus = {
            state: "failed",
            retryable: true,
            message: `${this.providerLabel()} rejected the token exchange (HTTP ${response.status}). Retry from DSH Settings.`,
          };
          return this.lastStatus;
        }
        const body = await jsonResponse(response);
        const grant = this.grantFromToken(
          body,
          attempt.metadata.token_endpoint,
          attempt.clientId,
          undefined,
        );
        await this.options.credentialStore.write(
          this.credentialRef,
          grantText(grant),
        );
        this.lastStatus = { state: "connected" };
        return this.lastStatus;
      } catch {
        this.lastStatus = {
          state: "failed",
          retryable: true,
          message: `${this.providerLabel()} token exchange could not be completed. Retry from DSH Settings.`,
        };
        return this.lastStatus;
      }
    })();
    this.callbackExchanges.set(attempt.id, exchange);
    try {
      return await exchange;
    } finally {
      if (this.callbackExchanges.get(attempt.id) === exchange)
        this.callbackExchanges.delete(attempt.id);
    }
  }

  /** Resolve and proactively refresh the current grant before one mail call. */
  async accessToken(): Promise<string> {
    const grant = await this.readGrant();
    if (!grant)
      throw new Error(
        "Mail is not connected. Connect the Agent mailbox from DSH Settings.",
      );
    if (grant.expiresAt > this.now() + OAUTH_EXPIRY_SKEW_MS)
      return grant.accessToken;
    if (!grant.refreshToken) throw safeRefreshError();
    const refreshed = await this.refresh(grant);
    return refreshed.accessToken;
  }

  async readGrant(): Promise<OAuthGrant | undefined> {
    try {
      const value = await this.options.credentialStore.read(this.credentialRef);
      const grant = parseGrant(credentialText(value));
      return this.options.grantBinding &&
        grant?.binding !== this.options.grantBinding
        ? undefined
        : grant;
    } catch {
      return undefined;
    }
  }

  private redirectUri(): string {
    return this.options.redirectUri ?? OAUTH_REDIRECT_URI;
  }

  private providerLabel(): string {
    return this.options.authorizationServer
      ? "OAuth provider"
      : "Cloudflare Access";
  }

  private safeFailureMessage(): string {
    return this.options.authorizationServer
      ? SAFE_FAILURE
      : `Mail authorization failed. Register ${this.redirectUri()} in Cloudflare Access and retry.`;
  }

  private resourceOrigin(): string {
    return new URL(this.options.resourceEndpoint).origin;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, attempt] of this.attempts) {
      if (attempt.expiresAt <= now) this.attempts.delete(id);
    }
    if (
      this.attempts.size === 0 &&
      this.callbackExchanges.size === 0 &&
      this.lastStatus.state === "pending"
    ) {
      this.lastStatus = {
        state: "failed",
        retryable: true,
        message: this.safeFailureMessage(),
      };
    }
  }

  private async metadata(): Promise<OAuthMetadata> {
    if (this.options.metadata)
      return metadataFrom(
        this.options.metadata as unknown as Record<string, unknown>,
      );
    if (!this.metadataPromise) {
      this.metadataPromise = this.discoverMetadata().catch((error: unknown) => {
        // A transient discovery failure must not poison the Settings retry
        // action with a permanently rejected promise.
        this.metadataPromise = undefined;
        throw error;
      });
    }
    return this.metadataPromise;
  }

  private async discoverMetadata(): Promise<OAuthMetadata> {
    if (!isSafeHttpsUrl(this.options.resourceEndpoint)) throw safeError();
    const resource = new URL(this.options.resourceEndpoint);
    let authorizationServer = this.options.authorizationServer;
    if (
      authorizationServer &&
      !isSafeAuthorizationServerUrl(authorizationServer)
    )
      throw safeError();
    if (!authorizationServer) {
      const protectedResource = new URL(
        "/.well-known/oauth-protected-resource",
        resource.origin,
      );
      try {
        const response = await this.fetcher(protectedResource);
        if (response.ok) {
          const body = (await response.json()) as {
            authorization_servers?: unknown;
          };
          const first = Array.isArray(body.authorization_servers)
            ? body.authorization_servers[0]
            : undefined;
          if (isSafeAuthorizationServerUrl(first)) authorizationServer = first;
        }
      } catch {
        // Fall through to the deployment's documented default issuer.
      }
    }
    authorizationServer ??= DEFAULT_OAUTH_AUTHORIZATION_SERVER;
    const issuerUrl = new URL(authorizationServer);
    const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
    for (const document of [
      "oauth-authorization-server",
      "openid-configuration",
    ]) {
      try {
        const response = await this.fetcher(
          `${issuerUrl.origin}/.well-known/${document}${issuerPath}`,
        );
        if (response.ok)
          return metadataFrom(
            (await response.json()) as Record<string, unknown>,
          );
      } catch {
        // Try the next standards-defined metadata location.
      }
    }
    throw safeError();
  }

  private async registerClient(metadata: OAuthMetadata): Promise<string> {
    if (this.options.clientId) return this.options.clientId;
    if (!metadata.registration_endpoint) throw safeError();
    const response = await this.fetcher(metadata.registration_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_name: this.options.clientName ?? DEFAULT_CLIENT_NAME,
        redirect_uris: [this.redirectUri()],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const body = await jsonResponse(response);
    const clientId = stringValue(body.client_id);
    if (!clientId) throw safeError();
    return clientId;
  }

  private grantFromToken(
    body: Record<string, unknown>,
    tokenEndpoint: string,
    clientId: string,
    prior: OAuthGrant | undefined,
  ): OAuthGrant {
    const accessToken = stringValue(body.access_token);
    if (!accessToken) throw safeError();
    const refreshToken = stringValue(body.refresh_token) ?? prior?.refreshToken;
    const expiresIn =
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600;
    const expiresAt =
      typeof body.expires_at === "number" && Number.isFinite(body.expires_at)
        ? body.expires_at * (body.expires_at < 10_000_000_000 ? 1000 : 1)
        : this.now() + Math.max(1, expiresIn) * 1000;
    const scope =
      stringValue(body.scope) ??
      prior?.scope ??
      (this.options.scope || undefined);
    return {
      accessToken,
      expiresAt,
      tokenEndpoint,
      clientId,
      tokenType: stringValue(body.token_type) ?? prior?.tokenType ?? "Bearer",
      ...(refreshToken ? { refreshToken } : {}),
      ...(scope ? { scope } : {}),
      ...(this.options.grantBinding
        ? { binding: this.options.grantBinding }
        : {}),
    };
  }

  private async refresh(prior: OAuthGrant): Promise<OAuthGrant> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const response = await this.fetcher(prior.tokenEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: prior.refreshToken!,
            client_id: prior.clientId,
            resource: this.resourceOrigin(),
          }),
        });
        const body = await jsonResponse(response);
        const grant = this.grantFromToken(
          body,
          prior.tokenEndpoint,
          prior.clientId,
          prior,
        );
        await this.options.credentialStore.write(
          this.credentialRef,
          grantText(grant),
        );
        this.lastStatus = { state: "connected" };
        return grant;
      } catch {
        throw safeRefreshError();
      } finally {
        this.refreshPromise = undefined;
      }
    })();
    return this.refreshPromise;
  }
}

export {
  challengeFor as pkceChallenge,
  parseGrant as parseOAuthGrant,
  grantText as serializeOAuthGrant,
};
