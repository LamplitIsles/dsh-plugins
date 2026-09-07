import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import {
  ALIBABA_CREDENTIAL_REF,
  BYTEDANCE_CREDENTIAL_REF,
  DEFAULT_ALIBABA_VOICE,
  DEFAULT_BYTEDANCE_VOICE,
  DEFAULT_PROVIDER,
  normalizeSettings
} from "../src/settings.js";
import { SpeechSettingsCard, describeCredential, decodeSettings, saveCredential, type ClientSettingsScope } from "../src/client/settings-card.js";
import type { SpeechSettings } from "../src/settings.js";

function snapshot(value: Partial<SpeechSettings> | undefined, writable = true, status: "ready" | "unavailable" = "ready", mode: "host" | "memory" = "host") {
  return { status, value, base: undefined, user: undefined, revision: 1, writable, mode };
}

function controlledScope(initial: Partial<SpeechSettings> = {}, writable = true, rejectFields = new Set<string>(), status: "ready" | "unavailable" = "ready", mode: "host" | "memory" = "host") {
  let currentSnapshot = snapshot(initial, writable, status, mode);
  const listeners = new Set<() => void>();
  const writes: Array<[string, unknown]> = [];
  const settings: ClientSettingsScope = {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate: async (ops) => {
      for (const op of ops) {
        const field = op.path[0];
        if (field === undefined) continue;
        if (op.op === "set") {
          writes.push([field, op.value]);
          if (rejectFields.has(field)) throw new Error("rejected");
          currentSnapshot = { ...currentSnapshot, value: { ...currentSnapshot.value, [field]: op.value } };
        } else {
          writes.push([field, undefined]);
          const value = { ...currentSnapshot.value };
          delete value[field as keyof typeof value];
          currentSnapshot = { ...currentSnapshot, value };
        }
      }
      listeners.forEach((listener) => listener());
    },
    set: async (field, value) => {
      writes.push([field, value]);
      if (rejectFields.has(field)) throw new Error("rejected");
      currentSnapshot = { ...currentSnapshot, value: { ...currentSnapshot.value, [field]: value } };
      listeners.forEach((listener) => listener());
    },
    unset: async (field) => {
      writes.push([field, undefined]);
      const value = { ...currentSnapshot.value };
      delete value[field as keyof typeof value];
      currentSnapshot = { ...currentSnapshot, value };
      listeners.forEach((listener) => listener());
    }
  };
  return { settings, writes, update(value: Partial<SpeechSettings>) { currentSnapshot = { ...currentSnapshot, value }; listeners.forEach((listener) => listener()); } };
}

function apiFor(statuses: Partial<Record<string, { configured: boolean; writable: boolean }>> = {}, writes: unknown[] = [], reject = false) {
  return {
    credentials: {
      describe: async (refs: string[]) => ({ ok: true, value: Object.fromEntries(refs.map((ref) => [ref, statuses[ref] ?? { configured: false, writable: true }])) }),
      set: async (ref: string, value: string) => { writes.push(["set", { ref, value }]); if (reject) throw new Error("rejected"); return { ok: true, value: undefined }; }
    }
  };
}

describe("dual-provider native settings card", () => {
  it("normalizes fresh/invalid settings and starts collapsed", () => {
    expect(normalizeSettings(undefined)).toEqual({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    expect(decodeSettings({ provider: "bytedance", alibabaVoice: "  custom  ", bytedanceVoice: "  voice  " })).toEqual({ provider: "bytedance", alibabaVoice: "custom", bytedanceVoice: "voice" });
    expect(decodeSettings({ provider: "nope", alibabaVoice: "", bytedanceVoice: "x".repeat(129) })).toEqual({ provider: DEFAULT_PROVIDER, alibabaVoice: DEFAULT_ALIBABA_VOICE, bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    const html = renderToStaticMarkup(createElement(SpeechSettingsCard, { scope: controlledScope().settings, api: apiFor() }));
    expect(html).toContain('aria-expanded="false"');
  });

  it("describes and saves each credential without exposing a secret", async () => {
    const calls: unknown[] = [];
    const writes: unknown[] = [];
    const api = {
      credentials: {
        describe: async (refs: string[]) => { calls.push(refs); return { ok: true, value: { [ALIBABA_CREDENTIAL_REF]: { configured: true, source: "file", writable: true } } }; },
        set: async (ref: string, value: string) => { writes.push({ ref, value }); return { ok: true, value: undefined }; }
      }
    };
    await expect(describeCredential(api)).resolves.toEqual({ configured: true, source: "file", writable: true });
    expect(calls).toEqual([[ALIBABA_CREDENTIAL_REF]]);
    await expect(describeCredential(api, BYTEDANCE_CREDENTIAL_REF)).resolves.toEqual({ configured: false, writable: false });
    await saveCredential(api, "new-secret", BYTEDANCE_CREDENTIAL_REF);
    expect(writes).toEqual([{ ref: BYTEDANCE_CREDENTIAL_REF, value: "new-secret" }]);
  });

  it("shows provider and free-form selected voice/key fields with independent drafts", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    const credentialWrites: unknown[] = [];
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor({}, credentialWrites) })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByType("select").props.value).toBe("alibaba");
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.type).toBe("text");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe(DEFAULT_BYTEDANCE_VOICE);
    await act(async () => { root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.onChange({ target: { value: "  custom-byte  " } }); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("Maia");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("  custom-byte  ");
    expect(credentialWrites).toEqual([]);
    root!.unmount();
  });

  it("keeps the shared DashScope credential visible and writable with ByteDance selected", async () => {
    const controlled = controlledScope({ provider: "bytedance", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    const credentialWrites: unknown[] = [];
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor({}, credentialWrites) })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });

    expect(root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.type).toBe("password");
    const shared = root!.root.findByProps({ "data-settings-field": "alibaba-credential" });
    expect(shared.props.type).toBe("password");
    expect(shared.props["data-credential-ref"]).toBe(ALIBABA_CREDENTIAL_REF);
    expect(root!.root.findAllByType("label").some((label) => label.children.join(" ").includes("Qwen speech recognition"))).toBe(true);

    await act(async () => { shared.props.onChange({ target: { value: "shared-secret" } }); });
    const save = root!.root.findAllByType("button").find((button) => button.props.children === "Save")!;
    await act(async () => { await save.props.onClick(); });
    expect(credentialWrites).toEqual([["set", { ref: ALIBABA_CREDENTIAL_REF, value: "shared-secret" }]]);
    expect(controlled.writes).toEqual([]);
    expect(root!.root.findByType("select").props.value).toBe("bytedance");
    root!.unmount();
  });

  it("keeps invalid drafts visible, associates validation, and disables Save", async () => {
    const controlled = controlledScope({ alibabaVoice: "Maia" });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    const input = root!.root.findByProps({ "data-settings-field": "alibaba-voice" });
    await act(async () => { input.props.onChange({ target: { value: "   " } }); });
    const invalidInput = root!.root.findByProps({ "data-settings-field": "alibaba-voice" });
    expect(invalidInput.props.value).toBe("   ");
    expect(invalidInput.props["aria-invalid"]).toBe(true);
    expect(root!.root.findByProps({ id: invalidInput.props["aria-describedby"] }).props.children).toBeTruthy();
    expect(root!.root.findAllByType("button").find((button) => button.props.children === "Save")!.props.disabled).toBe(true);
    await act(async () => { input.props.onChange({ target: { value: "x".repeat(129) } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toHaveLength(129);
    root!.unmount();
  });

  it("retains every staged draft through ordered rejection and later Host refreshes", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE }, true, new Set(["provider"]));
    const credentialWrites: unknown[] = [];
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor({}, credentialWrites) })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.onChange({ target: { value: "custom-alibaba" } }); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-credential" }).props.onChange({ target: { value: "secret" } }); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.onChange({ target: { value: "custom-bytedance" } }); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.onChange({ target: { value: "bytedance-secret" } }); });
    const save = root!.root.findAllByType("button").find((button) => button.props.children === "Save")!;
    await act(async () => { await save.props.onClick(); });
    expect(credentialWrites).toEqual([
      ["set", { ref: ALIBABA_CREDENTIAL_REF, value: "secret" }],
      ["set", { ref: BYTEDANCE_CREDENTIAL_REF, value: "bytedance-secret" }]
    ]);
    expect(controlled.writes).toEqual([
      ["alibabaVoice", "custom-alibaba"],
      ["bytedanceVoice", "custom-bytedance"],
      ["provider", "bytedance"]
    ]);
    expect(root!.root.findByType("select").props.value).toBe("bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("custom-bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.value).toBe("bytedance-secret");
    expect(root!.root.findByProps({ role: "status" }).children.join(" ")).toContain("did not accept");

    controlled.update({ provider: "alibaba", alibabaVoice: "custom-alibaba", bytedanceVoice: "custom-bytedance" });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByType("select").props.value).toBe("bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("custom-bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.value).toBe("bytedance-secret");
    controlled.update({ provider: "alibaba", alibabaVoice: "host-alibaba-again", bytedanceVoice: "host-bytedance-again" });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByType("select").props.value).toBe("bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("custom-bytedance");
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-credential" }).props.value).toBe("bytedance-secret");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("custom-alibaba");
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-credential" }).props.value).toBe("secret");
    root!.unmount();
  });

  it("follows clean host updates, preserves dirty drafts, and Discard restores the latest baseline", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.onChange({ target: { value: "draft" } }); });
    controlled.update({ provider: "bytedance", alibabaVoice: "host-new", bytedanceVoice: "host-byte" });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByProps({ "data-settings-field": "bytedance-voice" }).props.value).toBe("host-byte");
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("draft");
    const discard = root!.root.findAllByType("button").find((button) => button.props.children === "Discard")!;
    await act(async () => { discard.props.onClick(); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "alibaba" } }); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("host-new");
    root!.unmount();
  });

  it("clears a provider draft when the Host catches up, then follows its next refresh", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByType("select").props.onChange({ target: { value: "bytedance" } }); });

    controlled.update({ provider: "bytedance", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByType("select").props.value).toBe("bytedance");

    controlled.update({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByType("select").props.value).toBe("alibaba");
    root!.unmount();
  });

  it("clears a voice draft when the Host catches up, then follows its next refresh", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.onChange({ target: { value: "draft" } }); });

    controlled.update({ provider: "alibaba", alibabaVoice: "draft", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("draft");

    controlled.update({ provider: "alibaba", alibabaVoice: "host-after", bytedanceVoice: DEFAULT_BYTEDANCE_VOICE });
    await act(async () => { await Promise.resolve(); });
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.value).toBe("host-after");
    root!.unmount();
  });

  it.each([
    ["unavailable", "host"],
    ["ready", "memory"]
  ] as const)("hides the settings card for %s/%s snapshots", (status, mode) => {
    const html = renderToStaticMarkup(createElement(SpeechSettingsCard, {
      scope: controlledScope(undefined, false, new Set(), status, mode).settings,
      api: apiFor()
    }));
    expect(html).toBe("");
  });

  it("shows ready non-writable settings without allowing writes", async () => {
    const controlled = controlledScope({ provider: "alibaba", alibabaVoice: "Maia" }, false);
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor() })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByProps({ role: "status" }).children.join(" ")).toContain("read-only");
    expect(root!.root.findByType("select").props.disabled).toBe(true);
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-voice" }).props.disabled).toBe(true);
    expect(root!.root.findAllByProps({ type: "password" }).every((input) => input.props.disabled)).toBe(true);
    root!.unmount();
  });

  it("is read-only remotely", async () => {
    const controlled = controlledScope({ provider: "bytedance", bytedanceVoice: "voice" });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => { root = create(createElement(SpeechSettingsCard, { scope: controlled.settings, api: apiFor(), localOnly: false })); await Promise.resolve(); });
    await act(async () => { root!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(root!.root.findByProps({ role: "status" }).children.join(" ")).toContain("read-only");
    expect(root!.root.findByType("select").props.disabled).toBe(true);
    expect(root!.root.findAllByProps({ type: "password" }).every((input) => input.props.disabled)).toBe(true);
    expect(root!.root.findByProps({ "data-settings-field": "alibaba-credential" }).props.disabled).toBe(true);
    root!.unmount();
  });
});
