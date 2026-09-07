import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { CREDENTIAL_REF, RPC_CHANNEL, RPC_ENDPOINT, SETTINGS_NAMESPACE, type MatrixSettings } from "./constants.js";
import { decodeSettings } from "./settings-client.js";
import { MatrixSettingsCard, type CredentialApi, type ReadinessApi, type WorkspaceSource } from "./client/settings-card.js";
import { matrixLocale, type MatrixLocaleKey } from "./client/labels.js";

export const inject = ["connection", "locale", "remote", "remote.credentials", "settingsScope", "slots", "workspaces"] as const;

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "dsh-matrix": MatrixLocaleKey;
  }
}

function createReadinessApi(connection: Pick<ConnectionHandle, "rpc">): ReadinessApi {
  return {
    async get(signal?: AbortSignal): Promise<unknown> {
      return connection.rpc.call(RPC_CHANNEL, RPC_ENDPOINT, {}, signal);
    }
  };
}

export function apply(ctx: ClientContext): void {
  const clientRoot = ctx as ClientContext & {
    locale: { register: (namespace: string, dictionaries: { en: Record<string, string>; zh: Record<string, string> }) => unknown };
    slots: {
      inject: (name: string, factory: () => unknown) => unknown;
      register: (options: unknown, component: unknown) => unknown;
    };
  };
  ctx.effect(() => clientRoot.locale.register(SETTINGS_NAMESPACE, matrixLocale), "dsh-matrix: dictionaries");

  const scope = ctx.settingsScope.bind<Partial<MatrixSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings
  }) as SettingsScope<Partial<MatrixSettings>>;
  const clientContext = ctx as ClientContext & {
    connection: ConnectionHandle;
    remote: { credentials: CredentialApi["credentials"] };
    workspaces: { list: WorkspaceSource };
  };
  const connection = clientContext.connection;
  const api: CredentialApi = { credentials: clientContext.remote.credentials };
  const readiness = createReadinessApi(connection);

  clientRoot.slots.inject("settings.plugin.item", () => clientRoot.slots.register(
    {
      name: "settings.plugin.item",
      key: SETTINGS_NAMESPACE,
      priority: 0,
      inject: () => ({
        scope,
        workspaceSource: clientContext.workspaces.list,
        api,
        readiness
      }),
      locale: SETTINGS_NAMESPACE
    } as never,
    MatrixSettingsCard as never
  ));
}

export { MatrixSettingsCard, decodeSettings, describeCredential, saveCredential } from "./client/settings-card.js";
export { matrixLabels, matrixLocale, matrixZhLabels } from "./client/labels.js";
export type { ClientSettingsScope, CredentialApi, CredentialStatus, MatrixSettingsCardProps, ReadinessApi, WorkspaceChoice, WorkspaceSource } from "./client/settings-card.js";
export type { MatrixLocaleKey } from "./client/labels.js";
export { CREDENTIAL_REF, RPC_CHANNEL, RPC_ENDPOINT, SETTINGS_NAMESPACE } from "./constants.js";
export default { inject, apply };
