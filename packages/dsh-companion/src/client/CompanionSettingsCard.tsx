import {
  english,
  type CompanionLocaleKey,
  type CompanionTranslate,
} from "./locale.js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  AvatarReadError,
  changedSettingsPayload,
  mergeCleanSettingsDraft,
  readAvatar,
  relationshipControlsWritable,
  settingValueAccepted,
  type ClientSettings,
} from "./settings.js";
import styles from "./CompanionSettingsCard.module.css";

export interface CompanionSettingsCardProps {
  t?: CompanionTranslate;
  scope: SettingsScope<ClientSettings>;
  workspaceSource: {
    getSnapshot(): WorkspaceSnapshot;
    subscribe(listener: () => void): () => void;
  };
  currentAffinity?: () => Promise<number | undefined>;
  resetAffinity?: () => Promise<void>;
  setAffinity?: (value: number) => Promise<void>;
  clearSignature?: () => Promise<void>;
}

const EMPTY_WORKSPACES: WorkspaceSnapshot = {
  items: [],
  archivedSessionIds: [],
  state: "loading",
  phase: "pending",
  error: null,
};

export function CompanionSettingsCard({
  t = english,
  scope,
  workspaceSource,
  currentAffinity,
  resetAffinity,
  setAffinity,
  clearSignature,
}: CompanionSettingsCardProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<
    SettingsScopeSnapshot<ClientSettings>
  >(() => scope.getSnapshot());
  const workspaceSubscribe = useMemo(
    () => workspaceSource.subscribe.bind(workspaceSource),
    [workspaceSource],
  );
  const workspaceGetSnapshot = useMemo(
    () => workspaceSource.getSnapshot.bind(workspaceSource),
    [workspaceSource],
  );
  const workspaceSnapshot = useSyncExternalStore(
    workspaceSubscribe,
    workspaceGetSnapshot,
    () => EMPTY_WORKSPACES,
  );
  const workspaceChoices = workspaceSnapshot.items.map((workspace) => ({
    id: String(workspace.workspaceId),
    title: workspace.title,
    path: workspace.path,
  }));
  const empty: ClientSettings = {
    workspaceId: "",
    companionName: "Companion",
    userName: t("you"),
    preferredAddress: t("you"),
    defaultAffinity: 50,
  };
  const initial = snapshot.value ?? empty;
  const baselineRef = useRef(initial);
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState<ClientSettings>(initial);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CompanionLocaleKey | "">("");
  const [error, setError] = useState<CompanionLocaleKey | "">("");
  const [saving, setSaving] = useState(false);
  const [affinity, setCurrentAffinity] = useState<number | undefined>();
  const [affinityDraft, setAffinityDraft] = useState("50");
  useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  useEffect(() => {
    if (currentAffinity) {
      void currentAffinity()
        .then((value) => {
          setCurrentAffinity(value);
        })
        .catch(() => undefined);
    }
  }, [currentAffinity]);
  useEffect(() => {
    if (affinity !== undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- synchronize external affinity.
      setAffinityDraft(String(affinity));
    }
  }, [affinity]);
  const dirty = useMemo(
    () => Object.keys(changedSettingsPayload(draft, baseline)).length > 0,
    [draft, baseline],
  );
  useEffect(() => {
    if (!snapshot.value) return;
    const previous = baselineRef.current;
    baselineRef.current = snapshot.value;
    // oxlint-disable-next-line react/set-state-in-effect -- reconcile external settings.
    setBaseline(snapshot.value);
    setDraft((current) =>
      mergeCleanSettingsDraft(current, previous, snapshot.value!),
    );
  }, [snapshot.value]);
  if (snapshot.status === "loading" || snapshot.status === "unavailable")
    return null;
  const readOnly = !snapshot.writable;
  const controlsWritable = relationshipControlsWritable(readOnly, saving);
  const selectedWorkspaceExists = workspaceChoices.some(
    (workspace) => workspace.id === draft.workspaceId,
  );
  const selectedWorkspaceId = selectedWorkspaceExists ? draft.workspaceId : "";
  const set = <K extends keyof ClientSettings>(
    key: K,
    value: ClientSettings[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  async function save(): Promise<void> {
    if (readOnly || !dirty) return;
    setSaving(true);
    setError("");
    setStatus("settings.saving");
    try {
      const payload = changedSettingsPayload(draft, baselineRef.current);
      let accepted = true;
      for (const [key, value] of Object.entries(payload)) {
        await scope.set(key, value);
        accepted =
          settingValueAccepted(scope.getSnapshot().value, key, value) &&
          accepted;
      }
      if (!accepted) {
        setError("settings.rejected");
        setStatus("settings.unsaved");
        return;
      }
      const next = scope.getSnapshot().value ?? draft;
      baselineRef.current = next;
      setBaseline(next);
      setDraft(next);
      setStatus("settings.saved");
      setOpen(false);
    } catch {
      setError("settings.failed");
      setStatus("settings.unsaved");
    } finally {
      setSaving(false);
    }
  }
  function discard(): void {
    setDraft(baselineRef.current);
    setError("");
    setStatus("settings.discarded");
  }
  async function correctAffinity(): Promise<void> {
    const value = Number(affinityDraft);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      setError("settings.affinityInvalid");
      return;
    }
    try {
      await setAffinity?.(value);
      setCurrentAffinity(value);
      setStatus("settings.affinityUpdated");
      setError("");
    } catch {
      setError("settings.affinityFailed");
    }
  }
  async function avatar(
    kind: "companionAvatar" | "userAvatar",
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      set(kind, await readAvatar(file));
      setStatus("avatar.ready");
      setError("");
    } catch (cause) {
      setError(cause instanceof AvatarReadError ? cause.key : "avatar.invalid");
    }
  }
  return (
    <li className={`${styles.card} ${open ? styles.open : ""}`}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        aria-controls="dsh-companion-settings-body"
        aria-label={t(open ? "settings.collapse" : "settings.expand")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.headText}>
          <span className={styles.title}>{t("settings.title")}</span>
          <span className={styles.intro}>{t("settings.description")}</span>
        </span>
        {dirty && (
          <span className={styles.pending}>{t("settings.unsaved")}</span>
        )}
        <span
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id="dsh-companion-settings-body" className={styles.body}>
          {readOnly && (
            <output className={styles.readOnly}>
              {t("settings.readOnlyHint")}
            </output>
          )}
          <div className={styles.grid}>
            <label className={`${styles.field} ${styles.full}`}>
              <span className={styles.label}>Companion Workspace</span>
              <select
                aria-describedby="workspace-hint"
                className={`select select-sm ${styles.input}`}
                value={selectedWorkspaceId}
                onChange={(event) =>
                  set("workspaceId", event.currentTarget.value)
                }
                disabled={
                  readOnly ||
                  saving ||
                  workspaceSnapshot.state === "loading" ||
                  workspaceChoices.length === 0
                }
              >
                <option value="" disabled>
                  {workspaceSnapshot.state === "loading"
                    ? t("workspace.loading")
                    : workspaceChoices.length === 0
                      ? t("workspace.none")
                      : t("workspace.select")}
                </option>
                {workspaceChoices.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.title} — {workspace.path}
                  </option>
                ))}
              </select>
              <span
                id="workspace-hint"
                className={
                  draft.workspaceId && !selectedWorkspaceExists
                    ? styles.warning
                    : styles.hint
                }
              >
                {draft.workspaceId && !selectedWorkspaceExists
                  ? t("workspace.missing")
                  : t("workspace.hint")}
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>
                {t("settings.companionName")}
              </span>
              <input
                aria-describedby="identity-hint"
                className={styles.input}
                value={draft.companionName}
                onChange={(event) =>
                  set("companionName", event.currentTarget.value)
                }
                disabled={readOnly || saving}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t("settings.userName")}</span>
              <input
                aria-describedby="identity-hint"
                className={styles.input}
                value={draft.userName}
                onChange={(event) => set("userName", event.currentTarget.value)}
                disabled={readOnly || saving}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t("settings.address")}</span>
              <input
                aria-describedby="preferred-address-hint"
                className={styles.input}
                value={draft.preferredAddress}
                onChange={(event) =>
                  set("preferredAddress", event.currentTarget.value)
                }
                disabled={readOnly || saving}
              />
              <span id="preferred-address-hint" className={styles.hint}>
                {t("settings.addressHint")}
              </span>
            </label>
            <span id="identity-hint" className={styles.srOnly}>
              {t("settings.nameLimit")}
            </span>
            <label className={styles.field}>
              <span className={styles.label}>
                {t("settings.defaultAffinity")}
              </span>
              <input
                aria-describedby="affinity-hint"
                className={styles.input}
                type="number"
                min="0"
                max="100"
                step="1"
                value={draft.defaultAffinity}
                onChange={(event) =>
                  set(
                    "defaultAffinity",
                    Math.max(
                      0,
                      Math.min(100, Number(event.currentTarget.value) || 0),
                    ),
                  )
                }
                disabled={readOnly || saving}
              />
              <span id="affinity-hint" className={styles.hint}>
                {t("settings.defaultAffinityHint")}
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t("avatar.companion")}</span>
              <span className={styles.avatarRow}>
                {draft.companionAvatar ? (
                  <img
                    className={styles.avatar}
                    src={draft.companionAvatar.data}
                    alt={t("avatar.companionPreview")}
                  />
                ) : (
                  <span className={styles.avatar} aria-hidden="true" />
                )}
                <span className={styles.avatarPicker}>
                  <input
                    className={styles.fileInput}
                    aria-describedby="companion-avatar-hint"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => void avatar("companionAvatar", event)}
                    disabled={readOnly || saving}
                  />
                  <span className={styles.fileButton}>
                    {t("avatar.choose")}
                  </span>
                  <span className={styles.fileState}>
                    {draft.companionAvatar
                      ? t("avatar.selected")
                      : t("avatar.none")}
                  </span>
                </span>
              </span>
              <span id="companion-avatar-hint" className={styles.hint}>
                {t("avatar.hint")}
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{t("avatar.user")}</span>
              <span className={styles.avatarRow}>
                {draft.userAvatar ? (
                  <img
                    className={styles.avatar}
                    src={draft.userAvatar.data}
                    alt={t("avatar.userPreview")}
                  />
                ) : (
                  <span className={styles.avatar} aria-hidden="true" />
                )}
                <span className={styles.avatarPicker}>
                  <input
                    className={styles.fileInput}
                    aria-describedby="user-avatar-hint"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => void avatar("userAvatar", event)}
                    disabled={readOnly || saving}
                  />
                  <span className={styles.fileButton}>
                    {t("avatar.choose")}
                  </span>
                  <span className={styles.fileState}>
                    {draft.userAvatar ? t("avatar.selected") : t("avatar.none")}
                  </span>
                </span>
              </span>
              <span id="user-avatar-hint" className={styles.hint}>
                {t("avatar.hint")}
              </span>
            </label>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {t(error)}
            </p>
          )}
          <div className={styles.relationship}>
            <div className={styles.relationshipHead}>
              <span className={styles.label}>{t("relationship.current")}</span>
              <span className={styles.affinity}>
                {t("affinity.label")}{" "}
                {affinity === undefined ? t("loading") : affinity}
              </span>
            </div>
            {setAffinity && (
              <div className={styles.relationshipControl}>
                <label
                  className={styles.correctionLabel}
                  htmlFor="companion-affinity-correction"
                >
                  {t("affinity.adjust")}
                </label>
                <input
                  id="companion-affinity-correction"
                  aria-describedby="companion-affinity-correction-hint"
                  className={styles.input}
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={affinityDraft}
                  onChange={(event) =>
                    setAffinityDraft(event.currentTarget.value)
                  }
                  disabled={!controlsWritable}
                />
                <span
                  id="companion-affinity-correction-hint"
                  className={styles.srOnly}
                >
                  {t("affinity.hint")}
                </span>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => void correctAffinity()}
                  disabled={!controlsWritable}
                >
                  {t("apply")}
                </button>
              </div>
            )}
            <div className={styles.relationshipActions}>
              {resetAffinity && (
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() =>
                    void resetAffinity()
                      .then(() => currentAffinity?.().then(setCurrentAffinity))
                      .catch(() => setError("reset.failed"))
                  }
                  disabled={!controlsWritable}
                >
                  {t("affinity.reset")}
                </button>
              )}
              {clearSignature && (
                <button
                  className={styles.textButton}
                  type="button"
                  onClick={() =>
                    void clearSignature()
                      .then(() => setStatus("signature.cleared"))
                      .catch(() => setError("signature.failed"))
                  }
                  disabled={!controlsWritable}
                >
                  {t("signature.clear")}
                </button>
              )}
            </div>
          </div>
          <div className={styles.actions}>
            <output className={styles.status} aria-live="polite">
              {readOnly ? t("settings.readOnly") : status ? t(status) : ""}
            </output>
            <button
              type="button"
              className={styles.button}
              onClick={discard}
              disabled={!dirty || saving}
            >
              {t("discard")}
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => void save()}
              disabled={readOnly || !dirty || saving}
            >
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
