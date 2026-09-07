import { useEffect, useId, useState } from "react";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScope, SettingsScopeBinder, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { MailSettings, ConnectionState, ConnectionStatus } from "../constants.js";
import {
  DEFAULT_OAUTH_AUTHORIZATION_SERVER,
  GUION_MCP_ENDPOINT,
  OAUTH_CALLBACK_PATH,
  OAUTH_REDIRECT_URI,
  RPC_CANCEL,
  RPC_CHANNEL,
  RPC_START,
  RPC_STATUS,
  SETTINGS_NAMESPACE
} from "../constants.js";
import { decodeSettings } from "../settings-client.js";
import css from "./mail.module.dshcss";

export interface MailSettingsCardProps {
  readonly scope: SettingsScope<Partial<MailSettings>>;
  readonly connection: ConnectionHandle;
  readonly openUrl?: (url: string) => void;
}

export type MailClientContext = ClientContext & {
  readonly slots: SlotRegistry;
  readonly connection: ConnectionHandle;
  readonly settingsScope: SettingsScopeBinder;
};

interface SafeStatus {
  readonly state: ConnectionState;
  readonly retryable?: boolean;
  readonly message?: string;
  readonly authorizationUrl?: string;
  readonly attemptId?: string;
}

function snapshotValue(scope: SettingsScope<Partial<MailSettings>>): SettingsScopeSnapshot<Partial<MailSettings>> {
  return scope.getSnapshot();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeStatus(value: unknown): SafeStatus {
  if (!isRecord(value)) return { state: "failed", retryable: true, message: "Mail connection failed." };
  const state = value.state;
  if (state !== "idle" && state !== "pending" && state !== "connected" && state !== "failed" && state !== "cancelled") {
    return { state: "failed", retryable: true, message: "Mail connection failed." };
  }
  return {
    state,
    ...(value.retryable === true ? { retryable: true } : {}),
    ...(typeof value.message === "string" ? { message: value.message.slice(0, 256) } : {}),
    ...(typeof value.authorizationUrl === "string" ? { authorizationUrl: value.authorizationUrl } : {}),
    ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {})
  };
}

function unwrapRpc(result: unknown): unknown {
  if (!isRecord(result)) throw new Error("Mail connection is unavailable.");
  if (result.ok === false) {
    const error = isRecord(result.error) ? result.error.message : undefined;
    throw new Error(typeof error === "string" ? error.slice(0, 256) : "Mail connection is unavailable.");
  }
  return result.ok === true && "value" in result ? result.value : result;
}

function isBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function defaultOpenUrl(url: string): void {
  if (typeof globalThis.window !== "undefined") {
    globalThis.window.open(url, "dsh-mail-oauth", "noopener,noreferrer");
  }
}

function reserveAuthorizationWindow(): Window | null {
  if (typeof globalThis.window === "undefined") return null;
  try {
    const popup = globalThis.window.open("", "dsh-mail-oauth", "popup");
    // `noopener` makes window.open return null, which would prevent us from
    // navigating this user-initiated popup after the async Host RPC returns.
    if (popup) popup.opener = null;
    return popup;
  } catch {
    return null;
  }
}

const stateLabel: Record<ConnectionState, string> = {
  idle: "Not connected",
  pending: "Waiting for authorization",
  connected: "Connected",
  failed: "Connection failed",
  cancelled: "Authorization cancelled"
};

/** Compact, collapsed-by-default Host-owned OAuth card. */
export function MailSettingsCard(props: MailSettingsCardProps): JSX.Element | null {
  const snapshot = useScopeSnapshot(props.scope);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SafeStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [attemptId, setAttemptId] = useState<string | undefined>();
  const [draft, setDraft] = useState<Partial<MailSettings>>({});
  const [saveError, setSaveError] = useState<string | undefined>();
  const titleId = useId();
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    if (snapshot.status !== "ready") return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const result = await props.connection.rpc.call(RPC_CHANNEL, RPC_STATUS, {});
        if (!disposed) setStatus(safeStatus(unwrapRpc(result)));
      } catch (error) {
        if (!disposed) setStatus({ state: "failed", retryable: true, message: error instanceof Error ? error.message : "Mail connection failed." });
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, [props.connection, snapshot.status]);

  useEffect(() => {
    if (snapshot.status !== "ready" || status.state !== "pending") return;
    let disposed = false;
    const timer = globalThis.setInterval(() => {
      void props.connection.rpc.call(RPC_CHANNEL, RPC_STATUS, {})
        .then((result) => { if (!disposed) setStatus(safeStatus(unwrapRpc(result))); })
        .catch((error: unknown) => {
          if (!disposed) setStatus({ state: "failed", retryable: true, message: error instanceof Error ? error.message : "Mail connection failed." });
        });
    }, 1000);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
    };
  }, [props.connection, snapshot.status, status.state]);

  if (snapshot.status !== "ready") return null;
  const saved: MailSettings = {
    mailboxAddress: snapshot.value?.mailboxAddress ?? "",
    upstreamEndpoint: snapshot.value?.upstreamEndpoint ?? GUION_MCP_ENDPOINT,
    oauthAuthorizationServer: snapshot.value?.oauthAuthorizationServer ?? DEFAULT_OAUTH_AUTHORIZATION_SERVER,
    oauthCallbackUrl: snapshot.value?.oauthCallbackUrl ?? OAUTH_REDIRECT_URI
  };
  const values: MailSettings = { ...saved, ...draft };
  const dirty = values.mailboxAddress !== saved.mailboxAddress
    || values.upstreamEndpoint !== saved.upstreamEndpoint
    || values.oauthAuthorizationServer !== saved.oauthAuthorizationServer
    || values.oauthCallbackUrl !== saved.oauthCallbackUrl;
  const currentAttemptId = attemptId ?? status.attemptId;
  const statusText = status.message ?? stateLabel[status.state];

  const start = async (force = false): Promise<void> => {
    if (!saved.mailboxAddress) {
      setSaveError("Enter and save the Agent mailbox address first.");
      return;
    }
    // Reserve the popup while this click still has a browser user gesture.
    // Opening it after the asynchronous RPC response is commonly blocked.
    const authorizationWindow = props.openUrl ? null : reserveAuthorizationWindow();
    setBusy(true);
    setStatus({ state: "pending" });
    try {
      const result = await props.connection.rpc.call(RPC_CHANNEL, RPC_START, force ? { force: true } : {});
      const value = safeStatus(unwrapRpc(result));
      setStatus(value);
      setAttemptId(value.attemptId);
      if (value.authorizationUrl && isBrowserUrl(value.authorizationUrl)) {
        if (authorizationWindow) {
          authorizationWindow.location.replace(value.authorizationUrl);
          authorizationWindow.focus();
        } else {
          (props.openUrl ?? defaultOpenUrl)(value.authorizationUrl);
        }
      } else {
        authorizationWindow?.close();
      }
    } catch (error) {
      authorizationWindow?.close();
      setStatus({ state: "failed", retryable: true, message: error instanceof Error ? error.message : "Mail connection failed." });
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    const candidate = values.mailboxAddress.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) {
      setSaveError("Enter a valid mailbox address.");
      return;
    }
    setBusy(true);
    setSaveError(undefined);
    try {
      await props.scope.mutate([
        { op: "set", path: ["mailboxAddress"], value: candidate },
        { op: "set", path: ["upstreamEndpoint"], value: values.upstreamEndpoint },
        { op: "set", path: ["oauthAuthorizationServer"], value: values.oauthAuthorizationServer },
        { op: "set", path: ["oauthCallbackUrl"], value: values.oauthCallbackUrl }
      ]);
      setDraft({});
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save mailbox address.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await props.connection.rpc.call(RPC_CHANNEL, RPC_CANCEL, currentAttemptId ? { attemptId: currentAttemptId } : {});
      setStatus(safeStatus(unwrapRpc(result)));
      setAttemptId(undefined);
    } catch (error) {
      setStatus({ state: "failed", retryable: true, message: error instanceof Error ? error.message : "Mail connection failed." });
    } finally {
      setBusy(false);
    }
  };

  const connected = status.state === "connected";
  const pending = status.state === "pending";
  return (
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ""}`} data-plugin-card={SETTINGS_NAMESPACE}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-controls={descriptionId}
        aria-label={`${open ? "Collapse" : "Expand"}: Agent mailbox`}
        onClick={() => { setOpen(value => !value); }}
      >
        <span className={css.headText}>
          <span id={titleId} className={css.name}>Agent mailbox</span>
          <span className={css.description}>Send and manage mail through the configured mailbox.</span>
        </span>
        {pending ? <span className={css.pending}>Waiting</span> : null}
        <span className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id={descriptionId} className={css.body} aria-labelledby={titleId}>
          <div className={css.field}>
            <label className={css.mailboxLabel} htmlFor={`${titleId}-mailbox`}>Mailbox address</label>
            <input id={`${titleId}-mailbox`} className={css.mailbox} value={values.mailboxAddress} disabled={!snapshot.writable || busy} aria-describedby={`${titleId}-mailbox-help`} onChange={(event) => { setDraft(current => ({ ...current, mailboxAddress: event.target.value })); setSaveError(undefined); }} />
            <p id={`${titleId}-mailbox-help`} className={css.hint}>{snapshot.writable ? "This address is the Agent's one fixed mailbox." : "Mailbox settings are read-only in this DSH profile."}</p>
          </div>
          <div className={css.field}>
            <label className={css.mailboxLabel} htmlFor={`${titleId}-endpoint`}>MCP endpoint</label>
            <input id={`${titleId}-endpoint`} className={css.mailbox} value={values.upstreamEndpoint} disabled={!snapshot.writable || busy} aria-describedby={`${titleId}-endpoint-help`} onChange={(event) => { setDraft(current => ({ ...current, upstreamEndpoint: event.target.value })); setSaveError(undefined); }} />
            <p id={`${titleId}-endpoint-help`} className={css.hint}>Absolute HTTPS URL for the upstream mail MCP.</p>
          </div>
          <div className={css.field}>
            <label className={css.mailboxLabel} htmlFor={`${titleId}-issuer`}>OAuth issuer</label>
            <input id={`${titleId}-issuer`} className={css.mailbox} value={values.oauthAuthorizationServer} disabled={!snapshot.writable || busy} aria-describedby={`${titleId}-issuer-help`} onChange={(event) => { setDraft(current => ({ ...current, oauthAuthorizationServer: event.target.value })); setSaveError(undefined); }} />
            <p id={`${titleId}-issuer-help`} className={css.hint}>Absolute HTTPS authorization-server issuer.</p>
          </div>
          <div className={css.field}>
            <label className={css.mailboxLabel} htmlFor={`${titleId}-callback`}>OAuth callback URL</label>
            <input id={`${titleId}-callback`} className={css.mailbox} value={values.oauthCallbackUrl} disabled={!snapshot.writable || busy} aria-describedby={`${titleId}-callback-help`} onChange={(event) => { setDraft(current => ({ ...current, oauthCallbackUrl: event.target.value })); setSaveError(undefined); }} />
            <p id={`${titleId}-callback-help`} className={css.hint}>HTTPS or loopback HTTP; keep the `/oauth/dsh-mail/callback` path.</p>
          </div>
          {saveError ? <p className={`${css.hint} ${css.error}`} role="status">{saveError}</p> : null}
          <p className={`${css.status}${status.state === "failed" ? ` ${css.error}` : connected ? ` ${css.success}` : ""}`} role="status" data-connection-state={status.state}>
            <span className={css.statusState}>{statusLabel(status.state)}</span>
            <span>{statusText}</span>
          </p>
          <div className={css.actions}>
            {dirty ? <>
              <button type="button" className={css.secondary} disabled={busy} data-action="discard" onClick={() => { setDraft({}); setSaveError(undefined); }}>Discard</button>
              <button type="button" className={css.action} disabled={busy || !snapshot.writable} data-action="save" onClick={() => { void saveSettings(); }}>Save settings</button>
            </> : null}
            {pending ? (
              <button type="button" className={css.secondary} disabled={busy} data-action="cancel" onClick={() => { void cancel(); }}>Cancel</button>
            ) : null}
            {connected ? (
              <button type="button" className={css.secondary} disabled={busy || dirty || !saved.mailboxAddress} data-action="reconnect" onClick={() => { void start(true); }}>
                {busy ? "Connecting…" : "Reconnect mailbox"}
              </button>
            ) : (
              <button type="button" className={css.action} disabled={busy || dirty || !saved.mailboxAddress} data-action="connect" onClick={() => { void start(); }}>
                {busy ? "Connecting…" : "Connect mailbox"}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function statusLabel(state: ConnectionState): string {
  return stateLabel[state];
}

function useScopeSnapshot(scope: SettingsScope<Partial<MailSettings>>): SettingsScopeSnapshot<Partial<MailSettings>> {
  const [snapshot, setSnapshot] = useState(() => snapshotValue(scope));
  useEffect(() => {
    setSnapshot(snapshotValue(scope));
    return scope.subscribe(() => { setSnapshot(snapshotValue(scope)); });
  }, [scope]);
  return snapshot;
}

/** Client-side slot wiring kept separate so the card remains easy to test. */
export function registerMailSettingsCard(ctx: MailClientContext): void {
  const scope = ctx.settingsScope.bind<Partial<MailSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings
  });
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: SETTINGS_NAMESPACE,
    inject: () => ({ scope, connection: ctx.connection })
  }, MailSettingsCard));
}

export { OAUTH_CALLBACK_PATH };
