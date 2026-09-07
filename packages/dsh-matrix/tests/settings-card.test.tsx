import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { MatrixSettingsCard, type CredentialApi, type MatrixSettingsCardProps, type WorkspaceSource } from "../src/client/settings-card.js";

const initialValue = {
  homeserverUrl: "https://matrix.example",
  userId: "@bot:example",
  roomId: "!room:example",
  workspaceId: "w1",
  respondToAll: false
};

function scopeFixture(options: {
  status?: "loading" | "ready" | "unavailable";
  writable?: boolean;
  mode?: "host" | "memory";
} = {}) {
  let snapshot: any = {
    status: options.status ?? "ready",
    mode: options.mode ?? "host",
    writable: options.writable ?? true,
    value: { ...initialValue },
    base: {}, user: {}, revision: 1
  };
  const listeners = new Set<() => void>();
  const setCalls: Array<{ field: string; value: unknown }> = [];
  let rejectWrites = false;
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: async (field: string, value: unknown) => {
      setCalls.push({ field, value });
      if (rejectWrites) throw new Error("settings-rejected");
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } };
      for (const listener of listeners) listener();
    },
    unset: async () => undefined
  };
  return {
    scope,
    setCalls,
    rejectSettings(value = true) { rejectWrites = value; },
    publish(next: any) { snapshot = next; for (const listener of listeners) listener(); }
  };
}

function workspaceSourceFixture(phase: "pending" | "ready" = "ready"): WorkspaceSource {
  const snapshot = {
    items: [
      { workspaceId: "w1", title: "Main", path: "/workspaces/main", sessionIds: [], createdAt: "", updatedAt: "" },
      { workspaceId: "w2", title: "Other", path: "/workspaces/other", sessionIds: [], createdAt: "", updatedAt: "" }
    ],
    archivedSessionIds: [],
    state: phase === "pending" ? "loading" : "idle",
    phase,
    error: null
  } as unknown as WorkspaceSnapshot;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

function apiFixture(options: { rejectCredential?: boolean; writable?: boolean } = {}) {
  const setCalls: Array<{ ref: string; value: string }> = [];
  const describeCalls: string[][] = [];
  let rejectCredential = options.rejectCredential ?? false;
  const api: CredentialApi = {
    credentials: {
      describe: async (refs) => {
        describeCalls.push(refs);
        return { ok: true, value: { DSH_MATRIX_ACCESS_TOKEN: { configured: true, writable: options.writable ?? true } } };
      },
      set: async (ref, value) => {
        setCalls.push({ ref, value });
        if (rejectCredential) throw new Error("credential-rejected");
        return { ok: true };
      }
    }
  };
  return { api, setCalls, describeCalls, rejectCredential(value = true) { rejectCredential = value; } };
}

function props(
  fixture: ReturnType<typeof scopeFixture>,
  apiFixtureValue = apiFixture(),
  readiness: MatrixSettingsCardProps["readiness"] = { get: async () => ({ ok: true, value: { state: "bound", workspaceId: "w1", sessionId: "s1" } }) }
): MatrixSettingsCardProps {
  return {
    scope: fixture.scope as never,
    api: apiFixtureValue.api,
    readiness,
    workspaceSource: workspaceSourceFixture()
  };
}

function field(renderer: ReactTestRenderer, name: string) {
  return renderer.root.findByProps({ "data-settings-field": name });
}

async function renderCard(cardProps: MatrixSettingsCardProps) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<MatrixSettingsCard {...cardProps} />); });
  const headers = renderer.root.findAllByProps({ "data-plugin-card-header": "dsh-matrix" });
  if (headers[0]) await act(async () => { headers[0].props.onClick(); });
  return renderer;
}

describe("MatrixSettingsCard", () => {
  it("matches native plugin disclosure behavior by starting collapsed", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<MatrixSettingsCard {...props(scopeFixture())} />); });
    const header = renderer.root.findByProps({ "data-plugin-card-header": "dsh-matrix" });
    expect(header.props["aria-expanded"]).toBe(false);
    expect(renderer.root.findAllByProps({ "data-settings-field": "homeserverUrl" })).toHaveLength(0);
    await act(async () => { header.props.onClick(); });
    expect(renderer.root.findByProps({ "data-settings-field": "homeserverUrl" })).toBeTruthy();
    renderer.unmount();
  });

  it("hides an unavailable namespace and renders workspace/credential/readiness state when ready", async () => {
    const unavailable = scopeFixture({ status: "loading" });
    const unavailableRenderer = await renderCard(props(unavailable));
    expect(unavailableRenderer.toJSON()).toBeNull();
    unavailableRenderer.unmount();

    const ready = scopeFixture();
    const renderer = await renderCard(props(ready));
    expect(field(renderer, "workspaceId").props.value).toBe("w1");
    expect(field(renderer, "accessToken").props.type).toBe("password");
    expect(renderer.root.findByProps({ "data-readiness": "bound" })).toBeTruthy();
    renderer.unmount();
  });

  it("blocks saving when a required value is cleared", async () => {
    const fixture = scopeFixture();
    const renderer = await renderCard(props(fixture));
    await act(async () => { field(renderer, "homeserverUrl").props.onChange({ target: { value: "" } }); });
    expect(field(renderer, "homeserverUrl").props["aria-invalid"]).toBe(true);
    const save = renderer.root.findByProps({ children: "Save" });
    expect(save.props.disabled).toBe(true);
    await act(async () => { save.props.onClick(); });
    expect(fixture.setCalls).toEqual([]);
    renderer.unmount();
  });

  it("does not write settings or credentials from a read-only scope", async () => {
    const fixture = scopeFixture({ writable: false });
    const credentials = apiFixture();
    const renderer = await renderCard(props(fixture, credentials));
    await act(async () => {
      field(renderer, "roomId").props.onChange({ target: { value: "!draft:example" } });
      field(renderer, "accessToken").props.onChange({ target: { value: "new-token" } });
    });
    expect(field(renderer, "roomId").props.value).toBe("!room:example");
    expect(field(renderer, "accessToken").props.value).toBe("");
    expect(field(renderer, "accessToken").props.disabled).toBe(true);
    const save = renderer.root.findByProps({ children: "Save" });
    expect(save.props.disabled).toBe(true);
    await act(async () => { save.props.onClick(); });
    expect(fixture.setCalls).toEqual([]);
    expect(credentials.setCalls).toEqual([]);
    renderer.unmount();
  });

  it("replaces a configured credential and clears only after acceptance", async () => {
    const fixture = scopeFixture();
    const credentials = apiFixture();
    const renderer = await renderCard(props(fixture, credentials));
    await act(async () => { field(renderer, "accessToken").props.onChange({ target: { value: "  replacement-token  " } }); });
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick(); });
    expect(credentials.setCalls).toEqual([{ ref: "DSH_MATRIX_ACCESS_TOKEN", value: "replacement-token" }]);
    await act(async () => { renderer.root.findByProps({ "data-plugin-card-header": "dsh-matrix" }).props.onClick(); });
    expect(field(renderer, "accessToken").props.value).toBe("");
    renderer.unmount();
  });

  it("retains a draft when the settings save is rejected", async () => {
    const fixture = scopeFixture();
    fixture.rejectSettings();
    const renderer = await renderCard(props(fixture));
    await act(async () => { field(renderer, "roomId").props.onChange({ target: { value: "!draft:example" } }); });
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick(); });
    expect(field(renderer, "roomId").props.value).toBe("!draft:example");
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.props.children === "The deployment rejected these values; your draft was kept.")).toBe(true);
    renderer.unmount();
  });

  it("retains a draft when credential replacement is rejected", async () => {
    const fixture = scopeFixture();
    const credentials = apiFixture({ rejectCredential: true });
    const renderer = await renderCard(props(fixture, credentials));
    await act(async () => { field(renderer, "accessToken").props.onChange({ target: { value: "keep-this-token" } }); });
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick(); });
    expect(field(renderer, "accessToken").props.value).toBe("keep-this-token");
    expect(fixture.setCalls).toEqual([]);
    expect(renderer.root.findAllByProps({ role: "status" }).some((node) => node.props.children === "The deployment rejected these values; your draft was kept.")).toBe(true);
    renderer.unmount();
  });

  it.each(["disabled", "missing-settings", "missing-credential", "connecting", "bound", "unbound", "failed"] as const)("renders readiness state %s", async (state) => {
    const fixture = scopeFixture();
    const renderer = await renderCard(props(fixture, apiFixture(), { get: async () => ({ ok: true, value: { state } }) }));
    expect(renderer.root.findByProps({ "data-readiness": state })).toBeTruthy();
    renderer.unmount();
  });

  it("keeps a dirty draft across an external refresh and supports discard/save", async () => {
    const fixture = scopeFixture();
    const renderer = await renderCard(props(fixture));
    await act(async () => { field(renderer, "roomId").props.onChange({ target: { value: "!draft:example" } }); });
    fixture.publish({ ...fixture.scope.getSnapshot(), value: { ...fixture.scope.getSnapshot().value, roomId: "!external:example" } });
    expect(field(renderer, "roomId").props.value).toBe("!draft:example");
    const discard = renderer.root.findByProps({ children: "Discard" });
    await act(async () => { discard.props.onClick(); });
    expect(field(renderer, "roomId").props.value).toBe("!external:example");

    await act(async () => { field(renderer, "respondToAll").props.onChange({ target: { checked: true } }); });
    await act(async () => { renderer.root.findByProps({ children: "Save" }).props.onClick(); });
    expect(fixture.scope.getSnapshot().value.respondToAll).toBe(true);
    renderer.unmount();
  });

  it("falls back to the shared browser-safe labels", async () => {
    const fixture = scopeFixture();
    const renderer = await renderCard({ ...props(fixture), t: (() => undefined) as never });
    expect(JSON.stringify(renderer.toJSON())).toContain("Matrix companion");
    renderer.unmount();
  });
});
