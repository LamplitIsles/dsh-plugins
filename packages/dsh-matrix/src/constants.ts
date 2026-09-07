/** Stable package identity and the one settings/credential boundary owned by this plugin. */
export const PACKAGE_NAME = "dsh-matrix";
export const PACKAGE_SPECIFIER = "@lamplitisles/dsh-matrix";
export const SETTINGS_NAMESPACE = "dsh-matrix";
// Credential references use the DSH-wide POSIX environment-name grammar.
export const CREDENTIAL_REF = "DSH_MATRIX_ACCESS_TOKEN";
export const RPC_CHANNEL = "/dsh-matrix";
// Connection RPC endpoints are relative to the package-owned channel. The
// browser therefore calls /dsh-matrix/readiness, while the Host handler sees
// the endpoint name `readiness`.
export const RPC_ENDPOINT = "readiness";

/** In-memory bounds deliberately stay small: this plugin does not promise durable delivery. */
export const DEDUPE_LIMIT = 512;
export const UNBOUND_NOTICE_INTERVAL_MS = 60_000;
export const MAX_PROMPT_CHARS = 16_000;
export const MAX_PROVENANCE_CHARS = 512;
/** Native Matrix tools expose a finite roster and message payload. */
export const MAX_ROOM_MEMBERS = 128;
export const MAX_ROOM_MEMBER_ID_CHARS = MAX_PROVENANCE_CHARS;
export const MAX_MATRIX_TOOL_BODY_CHARS = MAX_PROMPT_CHARS;
/** Keep every upload bounded before it reaches the Matrix homeserver. */
export const MAX_MATRIX_MEDIA_BYTES = 10 * 1024 * 1024;
/** Stop waits briefly for classification before safely gating late callbacks. */
export const CLASSIFICATION_STOP_TIMEOUT_MS = 100;

export interface MatrixSettings {
  homeserverUrl: string;
  userId: string;
  roomId: string;
  workspaceId: string;
  respondToAll: boolean;
}

export const DEFAULT_SETTINGS: MatrixSettings = Object.freeze({
  homeserverUrl: "",
  userId: "",
  roomId: "",
  workspaceId: "",
  respondToAll: false
});
