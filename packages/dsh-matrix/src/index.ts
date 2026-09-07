import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createClient } from "matrix-js-sdk";
import { MatrixBridge, bridgeRpcHandler, type BridgeDependencies } from "./bridge.js";
import { CREDENTIAL_REF, RPC_CHANNEL, SETTINGS_NAMESPACE } from "./constants.js";
import { MatrixSettingsSchema } from "./settings.js";

export const name = "dsh-matrix";
export const inject = [
  "connection",
  "credentials",
  "settings",
  "tools",
  "systemPrompt",
  "workspaceRegistry",
  "sessionController"
] as const;

type HostContext = Context & {
  connection: {
    rpc: {
      handle: (channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) => () => Promise<void>;
    };
  };
  credentials: {
    resolve: (ref: ReturnType<typeof credentialRef>) => Promise<{ value: string; source?: string } | undefined>;
  };
  settings: {
    register: (namespace: string, schema: unknown, options?: unknown) => { get(): unknown };
  };
  workspaceRegistry: {
    get: (workspaceId: string) => {
      id: string;
      sessionIds: readonly string[];
    } | undefined;
    archivedSessionIds?: ReadonlySet<string> | readonly string[];
  };
  sessionController: {
    inspect: (sessionId: string, signal?: AbortSignal) => Promise<unknown>;
    resolveAgent: BridgeDependencies["resolveAgent"];
  };
};

/** Install the restart-scoped Host bridge and its read-only browser readiness endpoint. */
export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, MatrixSettingsSchema, {
    base: {
      homeserverUrl: "",
      userId: "",
      roomId: "",
      workspaceId: "",
      respondToAll: false
    },
    applies: "restart"
  });

  const bridge = new MatrixBridge({
    getSettings: () => settings.get(),
    resolveCredential: async (ref) => ctx.credentials.resolve(credentialRef(ref)),
    workspaceRegistry: ctx.workspaceRegistry,
    inspectSession: async (sessionId) => await ctx.sessionController.inspect(sessionId) as any,
    resolveAgent: async (sessionId) => await ctx.sessionController.resolveAgent(sessionId),
    matrixClientFactory: (options) => createClient(options) as any,
    onError: (error) => {
      // The SDK/credential error is intentionally not serialized into
      // readiness or logged with request settings. Even an exception message
      // supplied by a provider must not become a covert token echo.
      void error;
      if (process.env.NODE_ENV !== "test") console.error("[dsh-matrix] bridge error");
    }
  });

  ctx.effect(() => {
    const disposeRpc = ctx.connection.rpc.handle(RPC_CHANNEL, bridgeRpcHandler(bridge));
    void bridge.start();
    return async () => {
      await disposeRpc();
      await bridge.stop();
    };
  }, "dsh-matrix: bridge lifecycle");
}

export {
  MatrixBridge,
  bridgeRpcHandler
} from "./bridge.js";
export type {
  BridgeAgent,
  BridgeDependencies,
  BridgeReadiness,
  BridgeReadinessState
} from "./bridge.js";
export {
  captureMatrixEvent,
  cleanMatrixPrompt,
  EventDeduper,
  matrixEventContent,
  matrixEventId,
  matrixEventRoomId,
  matrixEventSender,
  matrixEventType,
  matrixMediaMessage,
  matrixMemberDisplayName,
  matrixTextMessage,
  readLocalRoomDisplayName,
  renderMatrixContextPrompt
} from "./matrix-protocol.js";
export type {
  AdmittedMatrixMessage,
  MatrixClientLike,
  MatrixContextRecord,
  MatrixEventLike,
  MatrixProvenance,
  MatrixRoomLike,
  MatrixTimelineData
} from "./matrix-protocol.js";
export {
  createMatrixToolDefinitions,
  listJoinedMatrixMembers,
  readRecentMatrixMessages,
  MATRIX_LIST_MEMBERS,
  MATRIX_READ_RECENT_MESSAGES,
  MATRIX_SEND_MESSAGE,
  MATRIX_SEND_FILE,
  MAX_RECENT_MESSAGES
} from "./matrix-tools.js";
export type {
  KeposSpeechServiceLike,
  MatrixListMembersResult,
  MatrixSendFileResult,
  MatrixReadRecentMessagesResult,
  MatrixRoomMember,
  MatrixSendMessageResult,
  MatrixToolAgentLike,
  MatrixToolDependencies,
  MatrixFileSystemLike
} from "./matrix-tools.js";
export {
  lastHumanPromptAt,
  selectMostRecentEligibleSession,
  selectedWorkspaceId
} from "./session-selection.js";
export type {
  ActiveSessionCandidate,
  SessionEventLike,
  SessionHeaderLike,
  SessionInspectionLike,
  WorkspaceLike
} from "./session-selection.js";
export {
  CREDENTIAL_REF,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  SETTINGS_NAMESPACE,
  MAX_MATRIX_TOOL_BODY_CHARS,
  MAX_MATRIX_MEDIA_BYTES,
  MAX_ROOM_MEMBER_ID_CHARS,
  MAX_ROOM_MEMBERS
} from "./constants.js";
export { DEFAULT_SETTINGS } from "./constants.js";
export { MatrixSettingsSchema } from "./settings.js";
export { decodeSettings, normalizeSettings, validateSettings } from "./settings-client.js";
export type { MatrixSettings } from "./constants.js";
export type { SettingsValidation } from "./settings-client.js";

export default { name, inject, apply };
