import { createElement, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import styles from "./matrix.module.dshcss";
import {
  CREDENTIAL_REF,
  DEFAULT_SETTINGS,
  SETTINGS_NAMESPACE,
  type MatrixSettings
} from "../constants.js";
import { decodeSettings, normalizeSettings, validateSettings } from "../settings-client.js";
import type { BridgeReadiness, BridgeReadinessState } from "../bridge.js";
import { matrixLabels } from "./labels.js";

export type ClientSettingsScope = SettingsScope<Partial<MatrixSettings>>;

export interface CredentialStatus {
  configured: boolean;
  writable: boolean;
}

export interface CredentialApi {
  credentials: {
    describe(refs: string[]): Promise<unknown>;
    set(ref: string, value: string): Promise<unknown>;
  };
}

export interface ReadinessApi {
  get(signal?: AbortSignal): Promise<unknown>;
}

export interface WorkspaceChoice {
  id?: string;
  workspaceId?: string;
  title?: string;
  path?: string;
}

export interface WorkspaceSource {
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface MatrixSettingsCardProps {
  scope: ClientSettingsScope;
  api: CredentialApi;
  readiness?: ReadinessApi;
  workspaceSource: WorkspaceSource;
  t?: (key: string) => string;
}

const EMPTY_CREDENTIAL: CredentialStatus = { configured: false, writable: false };
const EMPTY_READINESS: BridgeReadiness = { state: "missing-settings" };

function resultValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const result = value as { ok?: unknown; value?: unknown };
  return result.ok === true ? result.value : undefined;
}

export function credentialStatus(value: unknown, ref = CREDENTIAL_REF): CredentialStatus {
  const result = resultValue(value);
  if (!result || typeof result !== "object") return EMPTY_CREDENTIAL;
  const entry = (result as Record<string, unknown>)[ref];
  if (!entry || typeof entry !== "object") return EMPTY_CREDENTIAL;
  const row = entry as { configured?: unknown; writable?: unknown };
  return { configured: row.configured === true, writable: row.writable === true };
}

export async function describeCredential(api: CredentialApi, ref = CREDENTIAL_REF): Promise<CredentialStatus> {
  try {
    return credentialStatus(await api.credentials.describe([ref]), ref);
  } catch {
    return EMPTY_CREDENTIAL;
  }
}

export async function saveCredential(api: CredentialApi, value: string, ref = CREDENTIAL_REF): Promise<void> {
  const response = await api.credentials.set(ref, value);
  if (!response || typeof response !== "object" || (response as { ok?: unknown }).ok !== true) throw new Error("credential-rejected");
}

export { decodeSettings };

function readinessValue(value: unknown): BridgeReadiness {
  if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) return { state: "failed" };
  const candidate = resultValue(value);
  if (!candidate || typeof candidate !== "object") return EMPTY_READINESS;
  const state = (candidate as { state?: unknown }).state;
  const allowed: readonly BridgeReadinessState[] = ["disabled", "missing-settings", "missing-credential", "connecting", "bound", "unbound", "failed"];
  return { state: allowed.includes(state as BridgeReadinessState) ? state as BridgeReadinessState : "failed" };
}

function snapshotValue(snapshot: SettingsScopeSnapshot<Partial<MatrixSettings>>): MatrixSettings {
  return normalizeSettings(snapshot.value);
}

function fieldValue(baseline: MatrixSettings, draft: Partial<MatrixSettings>, field: keyof MatrixSettings): string | boolean {
  return draft[field] ?? baseline[field];
}

function getLabel(t: ((key: string) => string) | undefined, key: string): string {
  return t?.(key) ?? matrixLabels[key as keyof typeof matrixLabels] ?? key;
}

interface CardFrameProps {
  title: string;
  description: string;
  state: { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean };
  onSave: () => void;
  onDiscard: () => void;
  saveLabel: string;
  savingLabel: string;
  discardLabel: string;
  unsavedLabel: string;
  readOnlyLabel: string;
  failedLabel: string;
  children?: ReactNode;
}

/** Local equivalent of DSH's PluginCard chrome (the upstream card is not a runtime export). */
function PluginCardFrame(props: CardFrameProps) {
  const [open, setOpen] = useState(false);
  const saveStarted = useRef(false);
  useEffect(() => {
    if (props.state.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!props.state.dirty && !props.state.failed) setOpen(false);
  }, [props.state.dirty, props.state.failed, props.state.saving]);
  if (!props.state.available) return null;
  const bodyId = `${SETTINGS_NAMESPACE}-settings-body`;
  return createElement("li", { className: `${styles.card} ${open ? styles.cardOpen : ""}`, "data-plugin-card": SETTINGS_NAMESPACE },
    createElement("button", {
      type: "button",
      className: styles.header,
      "aria-expanded": open,
      "aria-controls": bodyId,
      "aria-label": `${open ? "Collapse" : "Expand"}: ${props.title}`,
      "data-plugin-card-header": SETTINGS_NAMESPACE,
      onClick: () => setOpen((value) => !value)
    },
    createElement("span", { className: styles.headText },
      createElement("span", { className: styles.name }, props.title),
      createElement("span", { className: styles.description }, props.description)
    ),
    props.state.dirty ? createElement("span", { className: styles.pending }, props.unsavedLabel) : null,
    createElement("span", { className: `${styles.chevron} ${open ? styles.chevronOpen : ""}`, "aria-hidden": true })
    ),
    open ? createElement("div", { id: bodyId, className: styles.body },
      !props.state.writable ? createElement("p", { className: styles.status, role: "status" }, props.readOnlyLabel) : null,
      props.children,
      createElement("div", { className: styles.footer },
        props.state.failed ? createElement("p", { className: `${styles.status} ${styles.invalid}`, role: "status" }, props.failedLabel) : null,
        createElement("button", { type: "button", className: styles.discard, disabled: !props.state.dirty || props.state.saving, onClick: props.onDiscard }, props.discardLabel),
        createElement("button", { type: "button", className: styles.save, disabled: !props.state.dirty || props.state.invalid || props.state.saving || !props.state.writable, onClick: props.onSave }, props.state.saving ? props.savingLabel : props.saveLabel)
      )
    ) : null
  );
}

/** Native PluginCard form with durable draft/baseline and write-only token semantics. */
const EMPTY_WORKSPACES: WorkspaceSnapshot = {
  items: [],
  archivedSessionIds: [],
  state: "loading",
  phase: "pending",
  error: null
};

export function MatrixSettingsCard({ scope, api, readiness, workspaceSource, t }: MatrixSettingsCardProps) {
  const initial = scope.getSnapshot();
  const [snapshot, setSnapshot] = useState(initial);
  const [baseline, setBaseline] = useState(() => snapshotValue(initial));
  const [draft, setDraft] = useState<Partial<MatrixSettings>>({});
  const [token, setToken] = useState("");
  const [credentials, setCredentials] = useState<CredentialStatus>(EMPTY_CREDENTIAL);
  const [runtime, setRuntime] = useState<BridgeReadiness>(EMPTY_READINESS);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const cardId = useId();

  useEffect(() => scope.subscribe(() => {
    const next = scope.getSnapshot();
    setSnapshot(next);
    setBaseline(snapshotValue(next));
    // Existing drafts intentionally survive external refreshes and rejected
    // writes; only Save/Discard clears them.
  }), [scope]);

  useEffect(() => {
    if (snapshot.status !== "ready" || snapshot.mode !== "host") return;
    let active = true;
    void describeCredential(api).then((status) => { if (active) setCredentials(status); });
    return () => { active = false; };
  }, [api, snapshot.mode, snapshot.status]);

  useEffect(() => {
    if (!readiness || snapshot.status !== "ready") return;
    let active = true;
    const read = async () => {
      try {
        const value = await readiness.get();
        if (active) setRuntime(readinessValue(value));
      } catch {
        if (active) setRuntime({ state: "failed" });
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [readiness, snapshot.status]);

  const workspaceSubscribe = useMemo(() => workspaceSource.subscribe.bind(workspaceSource), [workspaceSource]);
  const workspaceGetSnapshot = useMemo(() => workspaceSource.getSnapshot.bind(workspaceSource), [workspaceSource]);
  const workspaceState = useSyncExternalStore(workspaceSubscribe, workspaceGetSnapshot, () => EMPTY_WORKSPACES);
  const workspaceItems = workspaceState.items;
  const choices = useMemo(() => workspaceItems.map((item) => ({
    id: String(item.workspaceId),
    title: item.title || item.path || String(item.workspaceId)
  })), [workspaceItems]);
  const writable = snapshot.status === "ready" && snapshot.mode === "host" && snapshot.writable === true;
  const dirty = Object.keys(draft).length > 0 || token.trim().length > 0;
  const effective = {
    ...baseline,
    ...draft
  };
  const validation = validateSettings(effective);
  const workspaceStale = Boolean(effective.workspaceId && workspaceState.phase === "ready" && !choices.some((choice) => choice.id === effective.workspaceId));
  const invalid = !validation.valid || workspaceStale;

  const edit = <K extends keyof MatrixSettings>(field: K, value: MatrixSettings[K]) => {
    if (!writable || saving) return;
    setFailed(false);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const save = async () => {
    if (!writable || saving || invalid || !dirty) return;
    const staged = { ...draft };
    const stagedToken = token;
    setSaving(true);
    setFailed(false);
    try {
      if (stagedToken.trim()) await saveCredential(api, stagedToken.trim());
      for (const field of ["homeserverUrl", "userId", "roomId", "workspaceId", "respondToAll"] as const) {
        if (!(field in staged)) continue;
        await scope.set(field, staged[field]);
      }
      const next = scope.getSnapshot();
      setSnapshot(next);
      setBaseline(snapshotValue(next));
      setDraft({});
      setToken("");
      setCredentials(await describeCredential(api));
    } catch {
      // Keep every staged field and token so a rejected/conflicting write can
      // be corrected or retried without retyping the secret.
      setDraft(staged);
      setToken(stagedToken);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (saving) return;
    setDraft({});
    setToken("");
    setFailed(false);
  };

  const text = (key: string) => getLabel(t, key);
  const shell = {
    available: snapshot.status === "ready",
    writable,
    dirty,
    invalid,
    saving,
    failed
  };
  if (!shell.available) return null;
  const input = (field: keyof MatrixSettings, labelKey: string, hintKey: string, type = "text") => {
    const value = fieldValue(baseline, draft, field);
    const issue = validation.issues[field];
    return createElement("div", { className: styles.field, key: field },
      createElement("label", { className: styles.label, htmlFor: `${cardId}-${field}` }, text(labelKey)),
      createElement("input", {
        id: `${cardId}-${field}`,
        className: `${styles.input} ${issue ? styles.inputInvalid : ""}`,
        type,
        value: String(value),
        disabled: !writable || saving,
        onChange: (event: { target: { value: string } }) => edit(field, event.target.value as MatrixSettings[typeof field]),
        "aria-invalid": issue ? true : undefined,
        "aria-describedby": `${cardId}-${field}-hint`,
        "data-settings-field": field
      }),
      createElement("p", { className: `${styles.hint} ${issue ? styles.invalid : ""}`, id: `${cardId}-${field}-hint` }, issue === "required" ? text("required") : issue === "url" ? text("invalidUrl") : text(hintKey))
    );
  };

  const runtimeText = runtime.state === "unbound" ? text("unbound") : text(runtime.state);
  return createElement(PluginCardFrame, {
    title: text("title"),
    description: text("description"),
    state: shell,
    onSave: () => void save(),
    onDiscard: discard,
    saveLabel: text("save"),
    savingLabel: text("saving"),
    discardLabel: text("discard"),
    unsavedLabel: text("unsaved"),
    readOnlyLabel: text("readOnly"),
    failedLabel: text("saveFailed")
  },
  createElement("div", { className: styles.form, "data-settings-card": SETTINGS_NAMESPACE },
    createElement("div", { className: styles.settingsGrid },
      input("homeserverUrl", "homeserverUrl", "homeserverHint"),
      input("userId", "userId", "userIdHint"),
      input("roomId", "roomId", "roomIdHint"),
      createElement("div", { className: styles.field, key: "workspaceId" },
        createElement("label", { className: styles.label, htmlFor: `${cardId}-workspaceId` }, text("workspaceId")),
        createElement("select", {
          id: `${cardId}-workspaceId`,
          className: styles.select,
          value: String(fieldValue(baseline, draft, "workspaceId")),
          disabled: !writable || saving,
          onChange: (event: { target: { value: string } }) => edit("workspaceId", event.target.value),
          "aria-describedby": `${cardId}-workspaceId-hint`,
          "data-settings-field": "workspaceId"
        },
        createElement("option", { value: "" }, "—"),
        ...choices.map((choice) => createElement("option", { key: choice.id, value: choice.id }, choice.title)),
        workspaceStale ? createElement("option", { value: baseline.workspaceId }, baseline.workspaceId) : null),
        createElement("p", { className: `${styles.hint} ${workspaceStale ? styles.invalid : ""}`, id: `${cardId}-workspaceId-hint` }, workspaceStale ? text("workspaceMissing") : text("workspaceHint"))
      ),
      createElement("div", { className: styles.field, key: "accessToken" },
        createElement("label", { className: styles.label, htmlFor: `${cardId}-accessToken` }, text("accessToken")),
        createElement("input", {
          id: `${cardId}-accessToken`,
          className: styles.input,
          type: "password",
          autoComplete: "new-password",
          value: token,
          disabled: !writable || !credentials.writable || saving,
          onChange: (event: { target: { value: string } }) => {
            if (!writable || !credentials.writable || saving) return;
            setFailed(false);
            setToken(event.target.value);
          },
          "aria-describedby": `${cardId}-accessToken-hint`,
          "data-settings-field": "accessToken"
        }),
        createElement("span", { className: credentials.configured ? styles.credentialState : styles.credentialUnset, "data-credential-configured": credentials.configured ? "yes" : "no" }, credentials.configured ? text("configured") : text("notConfigured")),
        createElement("p", { className: styles.hint, id: `${cardId}-accessToken-hint` }, text("accessTokenHint"))
      )
    ),
    createElement("label", { className: styles.toggle, htmlFor: `${cardId}-respondToAll` },
      createElement("input", {
        id: `${cardId}-respondToAll`,
        className: styles.checkbox,
        type: "checkbox",
        checked: Boolean(fieldValue(baseline, draft, "respondToAll")),
        disabled: !writable || saving,
        onChange: (event: { target: { checked: boolean } }) => edit("respondToAll", event.target.checked),
        "data-settings-field": "respondToAll"
      }),
      createElement("span", null, text("respondToAll")),
      createElement("span", { className: styles.hint }, text("respondToAllHint"))
    ),
    createElement("div", { className: styles.runtime, role: "status", "data-readiness": runtime.state },
      createElement("strong", null, text("runtime")),
      createElement("span", { className: styles.runtimeState }, runtimeText)
    ),
    createElement("p", { className: styles.hint }, text("restartHint")),
  ));
}

export { DEFAULT_SETTINGS };
