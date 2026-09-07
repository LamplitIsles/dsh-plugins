import { createElement, useEffect, useId, useState } from "react";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";

import {
  DEFAULT_BANK_ID,
  normalizeCompanionSettings,
  SETTINGS_NAMESPACE,
} from "./settings.js";
import type { CompanionSettings } from "./settings.js";
import styles from "./HindsightSettings.module.dshcss";

export const inject = ["settingsScope", "slots"] as const;

type ClientSettingsScope = SettingsScope<Partial<CompanionSettings>>;

export interface BankIdDraft {
  value: string;
  saved: string;
}

/** Follow host updates only while the local field is clean. */
export function syncBankIdDraft(
  draft: BankIdDraft,
  saved: string,
): BankIdDraft {
  if (draft.saved === saved) return draft;
  const localValue = draft.value.trim() || DEFAULT_BANK_ID;
  return localValue === draft.saved
    ? { value: saved, saved }
    : { value: draft.value, saved };
}

/** Read only the explicit, non-secret companion settings from a client snapshot. */
export function decodeSettings(value: unknown): Partial<CompanionSettings> {
  const settings = normalizeCompanionSettings(value);
  return {
    bankId: settings.bankId,
  };
}

export async function saveSetting(
  scope: Pick<ClientSettingsScope, "set">,
  field: keyof CompanionSettings,
  value: CompanionSettings[keyof CompanionSettings],
): Promise<void> {
  await scope.set(field, value as never);
}

function SettingsCard({ scope }: { scope: ClientSettingsScope }) {
  const initialSnapshot = scope.getSnapshot();
  const initialBankId = normalizeCompanionSettings(initialSnapshot.value).bankId;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [draft, setDraft] = useState<BankIdDraft>({
    value: initialBankId,
    saved: initialBankId,
  });
  const [status, setStatus] = useState<"error">();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const cardId = useId();
  const settings = normalizeCompanionSettings(snapshot.value);
  const dirty = (draft.value.trim() || DEFAULT_BANK_ID) !== draft.saved;

  useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  useEffect(
    () => setDraft((current) => syncBankIdDraft(current, settings.bankId)),
    [settings.bankId],
  );

  const saveBank = async () => {
    setStatus(undefined);
    setSaving(true);
    try {
      const nextBankId = draft.value.trim() || DEFAULT_BANK_ID;
      await saveSetting(scope, "bankId", nextBankId);
      setDraft({ value: nextBankId, saved: nextBankId });
      setStatus(undefined);
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  if (snapshot.status !== "ready") return null;

  return createElement(
    "li",
    {
      className: `${styles.card} ${open ? styles.open : ""}`,
      "data-settings-card": SETTINGS_NAMESPACE,
    },
    createElement(
      "button",
      {
        type: "button",
        className: styles.header,
        "aria-expanded": open,
        "aria-controls": `${cardId}-body`,
        onClick: () => setOpen((value) => !value),
      },
      createElement(
        "span",
        { className: styles.headText },
        createElement("span", { className: styles.name }, "Hindsight memory"),
        createElement(
          "span",
          { className: styles.description },
          "Companion memory bank used for direct sessions.",
        ),
      ),
      dirty
        ? createElement("span", { className: styles.pending }, "Unsaved")
        : null,
      createElement(IconChevronDownOutline14, {
        className: `${styles.chevron} ${open ? styles.chevronOpen : ""}`,
      }),
    ),
    open
      ? createElement(
          "div",
          { className: styles.body, id: `${cardId}-body` },
          !snapshot.writable
            ? createElement(
                "p",
                { className: styles.readOnly, role: "status" },
                "These settings are read-only in this deployment.",
              )
            : null,
          createElement(
            "div",
            { className: styles.field },
            createElement(
              "label",
              { className: styles.label, htmlFor: `${cardId}-bank` },
              "Memory bank",
            ),
            createElement("input", {
              className: styles.control,
              id: `${cardId}-bank`,
              value: draft.value,
              "aria-describedby": `${cardId}-bank-hint`,
              disabled: saving || !snapshot.writable,
              onChange: (event: { target: { value: string } }) => {
                setDraft((current) => ({
                  ...current,
                  value: event.target.value,
                }));
                setStatus(undefined);
              },
            }),
            createElement(
              "p",
              { className: styles.hint, id: `${cardId}-bank-hint` },
              "One fixed bank for recall and retention. Default: yuki-memory.",
            ),
          ),
          createElement(
            "div",
            { className: styles.footer },
            status === "error"
              ? createElement(
                  "p",
                  { className: styles.error, role: "alert" },
                  "This setting could not be saved from this connection.",
                )
              : null,
            createElement(
              "button",
              {
                className: styles.discard,
                type: "button",
                disabled: !dirty || saving,
                onClick: () => {
                  setDraft({ value: draft.saved, saved: draft.saved });
                  setStatus(undefined);
                },
              },
              "Discard",
            ),
            createElement(
              "button",
              {
                className: styles.save,
                type: "button",
                disabled: !dirty || saving || !snapshot.writable,
                onClick: () => void saveBank(),
              },
              saving ? "Saving…" : "Save",
            ),
          ),
        )
      : null,
  );
}

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<Partial<CompanionSettings>>({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings,
  });
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: SETTINGS_NAMESPACE,
        inject: () => ({}),
      } as never,
      (() => createElement(SettingsCard, { scope })) as never,
    ),
  );
}
