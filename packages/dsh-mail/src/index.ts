import type { IncomingMessage, ServerResponse } from "node:http";
import {
  credentialKey,
  type CredentialKey,
  type CredentialRecord,
} from "@deepseek-ai/dsh-credentials";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { RuntimeFactory } from "./mcporter.js";
import {
  CREDENTIAL_REF,
  OAUTH_CALLBACK_PATH,
  PLUGIN_ID,
  RPC_CANCEL,
  RPC_CHANNEL,
  RPC_START,
  RPC_STATUS,
  CREDENTIAL_KEY_ID,
  SETTINGS_NAMESPACE,
  type ConnectionStatus,
  type MailConfig,
  type StartConnectionResult,
} from "./constants.js";
import { GuionMcpClient } from "./mcporter.js";
import {
  OAuthManager,
  type CredentialStore,
  type OAuthManagerOptions,
} from "./oauth.js";
import { createMailToolDefinitions } from "./mail-tools.js";
import {
  MailSettingsSchema,
  normalizeMailboxAddress,
  validateMailboxSetting,
} from "./settings.js";
import { resolveMailConfig } from "./config.js";
import type { MailSettings } from "./constants.js";
import z from "@deepseek-ai/schemastery";

export const name = PLUGIN_ID;
export const inject = [
  "webServer",
  "connection",
  "credentials",
  "settings",
  "tools",
] as const;

export const Config: z<MailConfig> = z.object({
  oauthScope: z.string().default(""),
  clientName: z.string().default("DSH Mail"),
});

export interface HostContext {
  effect(effect: () => unknown, label?: string): void;
  webServer: {
    register(route: {
      kind: "exact";
      path: string;
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>;
    }): () => void;
  };
  connection: {
    rpc: {
      handle: (
        channel: string,
        handler: (
          endpoint: string,
          payload: unknown,
          signal: AbortSignal,
        ) => Promise<HostRpcResult>,
      ) => () => Promise<void>;
    };
  };
  credentials: {
    readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
    modifyRecord(
      key: CredentialKey,
      mutate: (
        current: CredentialRecord | undefined,
      ) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined>;
    deleteRecord(key: CredentialKey): Promise<void>;
  };
  settings: {
    register(
      namespace: string,
      schema: unknown,
      options?: unknown,
    ): { get(): unknown };
  };
  tools: {
    register(tool: ToolDefinition): void;
  };
}

export type HostRpcResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: Record<string, unknown>;
      };
    };

export function createCredentialStore(
  credentials: HostContext["credentials"],
  grantKey: CredentialKey,
): CredentialStore {
  return {
    read: async () => {
      const record = await credentials.readRecord(grantKey);
      return record?.kind === "grant"
        ? { kind: "grant", payload: record.payload }
        : undefined;
    },
    write: async (_ref, value) => {
      let payload: unknown;
      try {
        payload = JSON.parse(value);
      } catch {
        throw new Error("Invalid mail grant.");
      }
      await credentials.modifyRecord(grantKey, async () => ({
        kind: "grant",
        payload,
      }));
    },
    clear: async () => {
      await credentials.deleteRecord(grantKey);
    },
  };
}

export interface MailServiceOptions {
  readonly config: MailConfig;
  readonly settings: () => MailSettings;
  readonly credentialStore: CredentialStore;
  readonly runtimeFactory?: RuntimeFactory;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/** Host-owned mailbox capability. Model arguments never choose its mailbox. */
export class MailService {
  private activeConfig: string | undefined;
  private oauth: OAuthManager | undefined;
  private mcp: GuionMcpClient | undefined;

  constructor(options: MailServiceOptions) {
    this.options = options;
  }

  private readonly options: MailServiceOptions;

  private clients(): { oauth: OAuthManager; mcp: GuionMcpClient } {
    const settings = this.options.settings();
    const connection = resolveMailConfig(settings);
    const key = JSON.stringify([
      connection.upstreamEndpoint,
      connection.oauthAuthorizationServer,
      connection.oauthCallbackUrl,
      this.options.config.oauthScope,
      this.options.config.clientName,
    ]);
    if (this.activeConfig !== key) {
      void this.mcp?.close();
      this.activeConfig = key;
      this.oauth = undefined;
      this.mcp = undefined;
    }
    if (this.oauth && this.mcp) return { oauth: this.oauth, mcp: this.mcp };
    const oauthOptions: OAuthManagerOptions = {
      credentialStore: this.options.credentialStore,
      resourceEndpoint: connection.upstreamEndpoint,
      authorizationServer: connection.oauthAuthorizationServer,
      ...(this.options.config.oauthScope
        ? { scope: this.options.config.oauthScope }
        : {}),
      ...(this.options.config.clientName
        ? { clientName: this.options.config.clientName }
        : {}),
      redirectUri: connection.oauthCallbackUrl,
      grantBinding: key,
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
    };
    this.oauth = new OAuthManager(oauthOptions);
    this.mcp = new GuionMcpClient({
      endpoint: connection.upstreamEndpoint,
      ...(this.options.runtimeFactory
        ? { runtimeFactory: this.options.runtimeFactory }
        : {}),
    });
    return { oauth: this.oauth, mcp: this.mcp };
  }

  startAuthorization(force = false): Promise<StartConnectionResult> {
    this.requireMailboxAddress(this.options.settings().mailboxAddress);
    return this.clients().oauth.start(force);
  }

  status(): Promise<ConnectionStatus> {
    return this.clients().oauth.status();
  }

  cancel(attemptId?: string): ConnectionStatus {
    return this.clients().oauth.cancel(attemptId);
  }

  callback(params: URLSearchParams): Promise<ConnectionStatus> {
    return this.clients().oauth.callback(params);
  }

  async call(
    tool: Parameters<GuionMcpClient["call"]>[0],
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { oauth, mcp } = this.clients();
    const mailboxAddress = this.requireMailboxAddress(
      this.options.settings().mailboxAddress,
    );
    const token = await oauth.accessToken();
    // Override even a direct caller's mailboxId. The public tool projections
    // never include that field, and this second boundary keeps the invariant
    // true for tests and future Host-only consumers too.
    const upstreamArgs = { ...args, mailboxId: mailboxAddress };
    return await mcp.call(tool, upstreamArgs, token, signal);
  }

  async close(): Promise<void> {
    await this.mcp?.close();
  }

  private requireMailboxAddress(value: unknown): string {
    try {
      return normalizeMailboxAddress(value);
    } catch {
      throw new Error(
        "Agent mailbox is not configured. Set it in DSH Settings before connecting or using mail.",
      );
    }
  }
}

function safeStatus(value: ConnectionStatus): ConnectionStatus {
  if (
    value.state === "connected" ||
    value.state === "pending" ||
    value.state === "cancelled" ||
    value.state === "failed" ||
    value.state === "idle"
  ) {
    return {
      state: value.state,
      ...(value.retryable === true ? { retryable: true } : {}),
      ...(typeof value.message === "string"
        ? { message: value.message.slice(0, 256) }
        : {}),
    };
  }
  return {
    state: "failed",
    retryable: true,
    message: "Mail authorization failed. Retry from DSH Settings.",
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function callbackPage(ok: boolean): string {
  const title = ok ? "DSH Mail connected" : "DSH Mail authorization failed";
  const message = ok
    ? "The Agent mailbox is connected. You may close this tab."
    : "Authorization failed. Return to DSH Settings and retry.";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>${title}</title><p>${message}</p>`;
}

async function callbackHandler(
  service: MailService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Method not allowed");
    return;
  }
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? OAUTH_CALLBACK_PATH, "http://127.0.0.1")
      .searchParams;
  } catch {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Invalid callback");
    return;
  }
  const status = await service.callback(params);
  const ok = status.state === "connected";
  res.writeHead(ok ? 200 : 400, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(callbackPage(ok));
}

async function rpcHandler(
  service: MailService,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<HostRpcResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "Mail request cancelled.",
        details: {},
      },
    };
  }
  try {
    const record = recordPayload(payload);
    if (endpoint === RPC_START)
      return {
        ok: true,
        value: await service.startAuthorization(record.force === true),
      };
    if (endpoint === RPC_STATUS)
      return { ok: true, value: safeStatus(await service.status()) };
    if (endpoint === RPC_CANCEL) {
      const attemptId =
        typeof record.attemptId === "string" ? record.attemptId : undefined;
      return { ok: true, value: safeStatus(service.cancel(attemptId)) };
    }
    return {
      ok: false,
      error: {
        code: "not-found",
        message: "Unknown dsh-mail RPC endpoint.",
        details: {},
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "internal",
        message: "Mail connection is unavailable.",
        details: {},
      },
    };
  }
}

export function apply(ctx: HostContext, config: MailConfig = {}): void {
  const settings = ctx.settings.register(
    SETTINGS_NAMESPACE,
    MailSettingsSchema,
    {
      applies: "live",
      validate: validateMailboxSetting,
    },
  );
  const grantKey = credentialKey(PLUGIN_ID, CREDENTIAL_KEY_ID);
  const credentialStore = createCredentialStore(ctx.credentials, grantKey);
  const service = new MailService({
    config,
    credentialStore,
    settings: () => settings.get() as MailSettings,
  });
  const tools = createMailToolDefinitions({
    call: async (tool, args, signal) => await service.call(tool, args, signal),
  });
  for (const tool of tools) ctx.tools.register(tool);
  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: "exact",
      path: OAUTH_CALLBACK_PATH,
      handler: (req, res) => callbackHandler(service, req, res),
    });
    const disposeRpc = ctx.connection.rpc.handle(
      RPC_CHANNEL,
      (endpoint, payload, signal) =>
        rpcHandler(service, endpoint, payload, signal),
    );
    return async () => {
      disposeRoute();
      await disposeRpc();
      await service.close();
    };
  }, "dsh-mail: OAuth callback and RPC lifecycle");
}

export {
  CREDENTIAL_KEY_ID,
  CREDENTIAL_REF,
  OAUTH_CALLBACK_PATH,
  RPC_CANCEL,
  RPC_CHANNEL,
  RPC_START,
  RPC_STATUS,
  SETTINGS_NAMESPACE,
};
export {
  createMailToolDefinitions,
  MAIL_LIST,
  MAIL_SEARCH,
  MAIL_READ,
  MAIL_READ_THREAD,
  MAIL_SEND,
  MAIL_REPLY,
  MAIL_TOOL_NAMES,
} from "./mail-tools.js";
export type { MailToolDependencies, MailToolResult } from "./mail-tools.js";
export { GuionMcpClient, normalizeMcpResult } from "./mcporter.js";
export type { McpRuntimeLike, RuntimeFactory } from "./mcporter.js";
export {
  OAuthManager,
  parseOAuthGrant,
  serializeOAuthGrant,
  pkceChallenge,
} from "./oauth.js";
export type {
  CredentialStore,
  OAuthGrant,
  OAuthMetadata,
  OAuthManagerOptions,
} from "./oauth.js";
export { MailSettingsSchema, normalizeMailboxAddress } from "./settings.js";
export {
  resolveMailConfig,
  validateHttpsUrl,
  validateOAuthAuthorizationServerUrl,
  validateOAuthCallbackUrl,
} from "./config.js";
export type {
  MailConfig,
  MailSettings,
  ConnectionStatus,
  ConnectionState,
  StartConnectionResult,
} from "./constants.js";

export default { name, inject, apply };
