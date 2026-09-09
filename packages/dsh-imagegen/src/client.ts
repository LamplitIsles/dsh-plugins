import {
  DEFAULT_BRIDGE_URL,
  ImagegenError,
  normalizeBridgeUrl,
  normalizeModel,
} from "./core.js";
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_GENERATION_MODEL,
  type ImagegenSettings,
} from "./constants.js";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  ISession,
  ISessions,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {
  SettingsScope as DshSettingsScope,
  SettingsScopeSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { IconChevronDownOutline14 } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { createElement, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import cssText from "./client.css";
import styles from "./settings.module.css";

export const SETTINGS_NAMESPACE = "lamplitisles-kepos-imagegen";
export const inject = ["sessions", "settingsScope", "slots"] as const;

export type ClientSettings = ImagegenSettings;

export type SettingsScope = Pick<
  DshSettingsScope<ClientSettings>,
  "getSnapshot" | "subscribe" | "mutate" | "set"
>;

export function decodeSettings(value: unknown): ClientSettings {
  if (value === undefined || value === null) {
    return defaultClientSettings();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ImagegenError("The Kepos image settings are invalid.");
  }
  const settings = value as Record<string, unknown>;
  return {
    bridgeUrl: validOrDefault(settings.bridgeUrl),
    generationModel: modelOrDefault(
      settings.generationModel,
      DEFAULT_GENERATION_MODEL,
    ),
    editModel: modelOrDefault(settings.editModel, DEFAULT_EDIT_MODEL),
  };
}

export type ImagegenSettingKey = keyof ClientSettings;

export function normalizeSetting(
  field: ImagegenSettingKey,
  value: string,
): string {
  return field === "bridgeUrl"
    ? normalizeBridgeUrl(value)
    : normalizeModel(value);
}

export async function saveSetting(
  scope: Pick<SettingsScope, "set">,
  field: ImagegenSettingKey,
  value: string,
): Promise<string> {
  const normalized = normalizeSetting(field, value);
  await scope.set(field, normalized);
  return normalized;
}

export function imagegenSettingsFromSnapshot(
  snapshot: SettingsScopeSnapshot<ClientSettings>,
): ClientSettings {
  return decodeSettings(snapshot.value);
}

export interface SettingDraft {
  value: string;
  saved: string;
}

export function syncSettingDraft(
  draft: SettingDraft,
  saved: string,
): SettingDraft {
  if (draft.saved === saved) return draft;
  return draft.value === draft.saved
    ? { value: saved, saved }
    : { value: draft.value, saved };
}

export interface ImagegenSettingsDraft {
  bridgeUrl: SettingDraft;
  generationModel: SettingDraft;
  editModel: SettingDraft;
}

export function syncImagegenSettingsDraft(
  draft: ImagegenSettingsDraft,
  saved: ClientSettings,
): ImagegenSettingsDraft {
  return {
    bridgeUrl: syncSettingDraft(draft.bridgeUrl, saved.bridgeUrl),
    generationModel: syncSettingDraft(
      draft.generationModel,
      saved.generationModel,
    ),
    editModel: syncSettingDraft(draft.editModel, saved.editModel),
  };
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(cssText), "kepos-imagegen: styles");
  const scope = ctx.settingsScope.bind({
    namespace: SETTINGS_NAMESPACE,
    decode: decodeSettings,
  });
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: SETTINGS_NAMESPACE,
      },
      () => createElement(SettingsCard, { scope }),
    ),
  );
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register(
      {
        name: "tool.call.toolview",
        key: "kepos_image_generate",
      },
      (props: ToolCallViewProps) =>
        createElement(ImageToolCard, { ...props, sessions: ctx.sessions }),
    ),
  );
}

type ImageToolCardProps = ToolCallViewProps & {
  sessions: Pick<ISessions, "binding">;
};

function ImageToolCard({ block, sessionId, sessions }: ImageToolCardProps) {
  const attachment = imageAttachmentFromBlock(block);
  const [src, setSrc] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!attachment) return;
    const session = sessions.binding(sessionId)?.session;
    if (!session) return;
    let live = true;
    let objectUrl: string | undefined;
    // Reset the preview as the external attachment identity changes.
    // oxlint-disable-next-line react/set-state-in-effect -- synchronize async attachment state.
    setSrc(undefined);
    setLoadFailed(false);
    session.readAttachment(attachment.attachmentId).then(
      (result: Awaited<ReturnType<ISession["readAttachment"]>>) => {
        if (!result.ok || !live) {
          if (live) setLoadFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.value.data)], {
            type: result.value.attachment.mediaType,
          }),
        );
        setSrc(objectUrl);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment, sessionId, sessions]);

  useEffect(() => {
    if (!previewOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [previewOpen]);

  if (!isToolResult(block)) {
    return createElement(
      "p",
      { className: "kepos-imagegen__notice" },
      "Generating image…",
    );
  }
  if (block.isError || !attachment) {
    return createElement(
      "p",
      { className: "kepos-imagegen__notice", role: "alert" },
      block.error
        ? `Image generation failed: ${block.error.name}.`
        : "Image generation failed.",
    );
  }
  const name = attachment.name ?? "kepos-image.png";
  const download = () => {
    if (!src) return;
    const link = document.createElement("a");
    link.href = src;
    link.download = name;
    link.click();
  };
  return createElement(
    "section",
    {
      className: "kepos-imagegen__card",
      "aria-label": "Generated Kepos image",
    },
    createElement(
      "p",
      { className: "kepos-imagegen__status" },
      "Image generated",
    ),
    loadFailed
      ? createElement("p", null, "Could not load the image preview.")
      : createElement(
          "button",
          {
            type: "button",
            disabled: !src,
            onClick: () => setPreviewOpen(true),
            title: "Open image preview",
            className: "kepos-imagegen__thumbnail",
          },
          src
            ? createElement("img", {
                src,
                alt: name,
                className: "kepos-imagegen__image",
              })
            : "Loading image…",
        ),
    createElement(
      "div",
      { className: "kepos-imagegen__actions" },
      createElement(
        "code",
        { className: "kepos-imagegen__path", title: outputPath(block) },
        outputPath(block),
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: download,
          disabled: !src,
          className: "kepos-imagegen__button",
        },
        "Download PNG",
      ),
    ),
    previewOpen && src
      ? createPortal(
          createElement(
            "div",
            {
              role: "dialog",
              "aria-modal": true,
              "aria-label": "Image preview",
              className: "kepos-imagegen__lightbox",
            },
            createElement("div", {
              "aria-hidden": true,
              onMouseDown: () => setPreviewOpen(false),
              className: "kepos-imagegen__backdrop",
            }),
            createElement("img", {
              src,
              alt: name,
              className: "kepos-imagegen__preview",
            }),
            createElement(
              "button",
              {
                type: "button",
                onClick: () => setPreviewOpen(false),
                className: "kepos-imagegen__close",
              },
              "Close",
            ),
          ),
          document.body,
        )
      : null,
  );
}

function imageAttachmentFromBlock(
  block: ToolCallViewProps["block"],
): ImageAttachmentRef | undefined {
  if (!isToolResult(block)) return undefined;
  const image = block.content.find((item) => item.type === "image");
  return image?.type === "image" ? image.attachment : undefined;
}

function outputPath(block: ToolCallViewProps["block"]): string {
  if (!isToolResult(block)) return "Saving to workspace…";
  const text = block.content.find((item) => item.type === "text");
  const match =
    text?.type === "text" ? /saved to (.+)\.$/.exec(text.text) : null;
  return match?.[1] ?? ".dsh/kepos-imagegen";
}

function isToolResult(
  block: ToolCallViewProps["block"],
): block is Extract<ToolCallViewProps["block"], { kind: "tool-result" }> {
  return "kind" in block && block.kind === "tool-result";
}

function SettingsCard({ scope }: { scope: SettingsScope }) {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());
  const initialSettings = imagegenSettingsFromSnapshot(snapshot);
  const [draft, setDraft] = useState<ImagegenSettingsDraft>(() =>
    imagegenSettingsDraft(initialSettings),
  );
  const [feedback, setFeedback] = useState<SettingsFeedback>();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const cardId = useId();

  useEffect(
    () => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
    [scope],
  );
  const saved = useMemo(
    () => imagegenSettingsFromSnapshot(snapshot),
    [snapshot],
  );
  const dirty = Object.values(draft).some(
    ({ value, saved: savedValue }) => value !== savedValue,
  );
  useEffect(() => {
    // Reconcile an external Host snapshot without overwriting local edits.
    // oxlint-disable-next-line react/set-state-in-effect -- this is external-store reconciliation.
    setDraft((current) => syncImagegenSettingsDraft(current, saved));
  }, [saved]);

  const setFieldValue = (field: ImagegenSettingKey, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: { ...current[field], value },
    }));
    setFeedback(undefined);
  };

  const save = async () => {
    setFeedback(undefined);
    const normalized = {} as Record<ImagegenSettingKey, string>;
    for (const field of IMAGEGEN_SETTING_KEYS) {
      try {
        normalized[field] = normalizeSetting(field, draft[field].value);
      } catch (error) {
        setFeedback({
          field,
          message: error instanceof Error ? error.message : "Invalid setting.",
        });
        return;
      }
    }

    try {
      setSaving(true);
      const changes = IMAGEGEN_SETTING_KEYS.filter(
        (field) => normalized[field] !== draft[field].saved,
      ).map((field) => ({
        op: "set" as const,
        path: [field],
        value: normalized[field],
      }));
      if (changes.length > 0) await scope.mutate(changes);
      setDraft({
        bridgeUrl: {
          value: normalized.bridgeUrl,
          saved: normalized.bridgeUrl,
        },
        generationModel: {
          value: normalized.generationModel,
          saved: normalized.generationModel,
        },
        editModel: {
          value: normalized.editModel,
          saved: normalized.editModel,
        },
      });
      setFeedback(undefined);
      setOpen(false);
    } catch (error) {
      setFeedback({
        message:
          error instanceof Error
            ? error.message
            : "Image settings could not be saved from this connection.",
      });
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
        createElement(
          "span",
          { className: styles.name },
          "Kepos Image Generation",
        ),
        createElement(
          "span",
          { className: styles.description },
          "Bridge and model policy for generated image attachments.",
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
                "This deployment is read-only.",
              )
            : null,
          renderSettingField(
            "bridgeUrl",
            "bridge",
            "Kepos bridge address",
            "The plugin appends /codex/images to this address.",
          ),
          renderSettingField(
            "generationModel",
            "generation-model",
            "Generation model",
            `Used when images are omitted. Default: ${DEFAULT_GENERATION_MODEL}.`,
          ),
          renderSettingField(
            "editModel",
            "edit-model",
            "Editing model",
            `Used with one through five source images. Default: ${DEFAULT_EDIT_MODEL}.`,
          ),
          createElement(
            "div",
            { className: styles.footer },
            feedback && feedback.field === undefined
              ? createElement(
                  "p",
                  {
                    className: styles.error,
                    id: `${cardId}-save-error`,
                    role: "alert",
                  },
                  feedback.message,
                )
              : null,
            createElement(
              "button",
              {
                className: styles.discard,
                type: "button",
                disabled: !dirty || saving,
                onClick: () => {
                  setDraft(imagegenSettingsDraft(saved));
                  setFeedback(undefined);
                },
              },
              "Discard",
            ),
            createElement(
              "button",
              {
                className: styles.save,
                type: "button",
                onClick: () => void save(),
                disabled: !dirty || saving || !snapshot.writable,
              },
              saving ? "Saving…" : "Save",
            ),
          ),
        )
      : null,
  );

  function renderSettingField(
    field: ImagegenSettingKey,
    idSuffix: string,
    label: string,
    hint: string,
  ) {
    const fieldError = feedback?.field === field ? feedback.message : undefined;
    const hintId = `${cardId}-${idSuffix}-hint`;
    const errorId = `${cardId}-${idSuffix}-error`;
    const describedBy = [hintId];
    if (fieldError) describedBy.push(errorId);
    else if (feedback !== undefined && feedback.field === undefined) {
      describedBy.push(`${cardId}-save-error`);
    }
    return createElement(
      "div",
      { className: styles.field, key: field },
      createElement(
        "label",
        { className: styles.label, htmlFor: `${cardId}-${idSuffix}` },
        label,
      ),
      createElement("input", {
        className: styles.control,
        id: `${cardId}-${idSuffix}`,
        type: "text",
        value: draft[field].value,
        "aria-describedby": describedBy.join(" "),
        "aria-invalid": fieldError ? true : undefined,
        disabled: saving || !snapshot.writable,
        onChange: (event: { target: { value: string } }) =>
          setFieldValue(field, event.target.value),
      }),
      createElement("p", { className: styles.hint, id: hintId }, hint),
      fieldError
        ? createElement(
            "p",
            { className: styles.error, id: errorId, role: "alert" },
            fieldError,
          )
        : null,
    );
  }
}

const IMAGEGEN_SETTING_KEYS = [
  "bridgeUrl",
  "generationModel",
  "editModel",
] as const satisfies readonly ImagegenSettingKey[];

type SettingsFeedback = {
  field?: ImagegenSettingKey;
  message: string;
};

function imagegenSettingsDraft(
  settings: ClientSettings,
): ImagegenSettingsDraft {
  return {
    bridgeUrl: { value: settings.bridgeUrl, saved: settings.bridgeUrl },
    generationModel: {
      value: settings.generationModel,
      saved: settings.generationModel,
    },
    editModel: { value: settings.editModel, saved: settings.editModel },
  };
}

function installStyles(css: string): () => void {
  const style = document.createElement("style");
  style.dataset.dshPlugin = "kepos-imagegen";
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

function validOrDefault(value: unknown): string {
  try {
    return normalizeBridgeUrl(
      typeof value === "string" ? value : DEFAULT_BRIDGE_URL,
    );
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

function defaultClientSettings(): ClientSettings {
  return {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    generationModel: DEFAULT_GENERATION_MODEL,
    editModel: DEFAULT_EDIT_MODEL,
  };
}

function modelOrDefault(value: unknown, fallback: string): string {
  return value === undefined ? fallback : normalizeModel(value);
}
