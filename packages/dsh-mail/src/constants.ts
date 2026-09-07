export const PLUGIN_ID = "dsh-mail" as const;
export const SETTINGS_NAMESPACE = "dsh-mail" as const;
// Dedicated Connection RPC channels are absolute URL path prefixes.
export const RPC_CHANNEL = "/dsh-mail" as const;
export const RPC_START = "start" as const;
export const RPC_STATUS = "status" as const;
export const RPC_CANCEL = "cancel" as const;
export const OAUTH_CALLBACK_PATH = "/oauth/dsh-mail/callback" as const;
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:3080${OAUTH_CALLBACK_PATH}` as const;
export const CREDENTIAL_REF = "DSH_MAIL_OAUTH_GRANT" as const;
/** Stable id used inside the DSH credential-key space (`dsh-mail/<id>`). */
export const CREDENTIAL_KEY_ID = "oauth-grant" as const;
export const MCP_SERVER_NAME = "guion-email" as const;
export const GUION_MCP_ENDPOINT = "https://mail.guion.io/mcp" as const;
export const DEFAULT_OAUTH_AUTHORIZATION_SERVER = "https://guionai.cloudflareaccess.com" as const;
export const DEFAULT_CLIENT_NAME = "DSH Mail" as const;
export const OAUTH_ATTEMPT_TTL_MS = 5 * 60_000;
export const OAUTH_EXPIRY_SKEW_MS = 60_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MAX_MAILBOX_LENGTH = 320;
export const MAX_TOOL_TEXT_LENGTH = 64_000;

/** The only six upstream capabilities the Host may invoke. */
export const UPSTREAM_TOOL_NAMES = Object.freeze([
  "list_emails",
  "search_emails",
  "get_email",
  "get_thread",
  "send_email",
  "send_reply"
] as const);

export type UpstreamToolName = typeof UPSTREAM_TOOL_NAMES[number];

export interface MailConnectionConfig {
  readonly upstreamEndpoint?: string;
  readonly oauthAuthorizationServer?: string;
  readonly oauthCallbackUrl?: string;
}

export interface MailConfig {
  readonly oauthScope?: string;
  readonly clientName?: string;
}

export interface MailSettings extends Required<MailConnectionConfig> {
  readonly mailboxAddress: string;
}

export type ConnectionState = "idle" | "pending" | "connected" | "failed" | "cancelled";

export interface ConnectionStatus {
  readonly state: ConnectionState;
  readonly retryable?: boolean;
  readonly message?: string;
}

export interface StartConnectionResult extends ConnectionStatus {
  readonly state: "pending" | "connected" | "failed";
  readonly authorizationUrl?: string;
  readonly attemptId?: string;
}
