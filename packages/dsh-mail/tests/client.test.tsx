import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import { MailSettingsCard } from "../src/client/settings-card.js";

function scope(status: SettingsScopeSnapshot<{ mailboxAddress?: string }>["status"] = "ready"): SettingsScope<{ mailboxAddress?: string }> {
  const snapshot: SettingsScopeSnapshot<{ mailboxAddress?: string }> = {
    status,
    value: status === "ready" ? { mailboxAddress: "agent@example.com" } : undefined,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: false,
    mode: "host"
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    mutate: async () => undefined,
    set: async () => undefined,
    unset: async () => undefined
  };
}

function connection(responses: unknown[]): { handle: ConnectionHandle; calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const handle = {
    rpc: {
      call: async (_channel: string, endpoint: string, payload: unknown) => {
        calls.push({ endpoint, payload });
        return { ok: true, value: responses.shift() ?? { state: "idle" } };
      }
    }
  } as unknown as ConnectionHandle;
  return { handle, calls };
}

function findAction(renderer: ReactTestRenderer, action: string) {
  return renderer.root.find((node) => node.props["data-action"] === action);
}

function editableScope(mutations: unknown[][]): SettingsScope<{ mailboxAddress?: string; upstreamEndpoint?: string; oauthAuthorizationServer?: string; oauthCallbackUrl?: string }> {
  const snapshot: SettingsScopeSnapshot<{ mailboxAddress?: string; upstreamEndpoint?: string; oauthAuthorizationServer?: string; oauthCallbackUrl?: string }> = {
    status: "ready",
    value: {
      mailboxAddress: "agent@example.com",
      upstreamEndpoint: "https://mail.example.test/mcp",
      oauthAuthorizationServer: "https://login.example.test",
      oauthCallbackUrl: "http://127.0.0.1:3080/oauth/dsh-mail/callback"
    },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: "host"
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    mutate: async (ops) => { mutations.push([...ops]); },
    set: async () => undefined,
    unset: async () => undefined
  };
}

describe("mail settings card", () => {
  it("does not render when the Host does not serve the namespace", () => {
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<MailSettingsCard scope={scope("unavailable")} connection={connection([]).handle} />); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("opens only the Host-returned authorization URL and keeps token data out of the card", async () => {
    const transport = connection([
      { state: "idle" },
      { state: "pending", attemptId: "attempt-1", authorizationUrl: "https://access.example/authorize?state=1" },
      { state: "connected", access_token: "must-not-render" }
    ]);
    const opened: string[] = [];
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<MailSettingsCard scope={scope()} connection={transport.handle} openUrl={(url) => { opened.push(url); }} />);
    });
    await act(async () => { await Promise.resolve(); });
    act(() => { renderer!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-connection-state": "idle" })).toBeTruthy();
    await act(async () => { findAction(renderer!, "connect").props.onClick(); await Promise.resolve(); });
    expect(opened).toEqual(["https://access.example/authorize?state=1"]);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("must-not-render");
    expect(transport.calls.map((call) => call.endpoint)).toContain("start");
  });

  it("renders a pending cancellation action and can retry a failed state", async () => {
    const transport = connection([
      { state: "idle" },
      { state: "pending", attemptId: "attempt-1" },
      { state: "cancelled", retryable: true },
      { state: "failed", retryable: true, message: "Retry me" }
    ]);
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<MailSettingsCard scope={scope()} connection={transport.handle} />); });
    await act(async () => { await Promise.resolve(); });
    act(() => { renderer!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    await act(async () => { findAction(renderer!, "connect").props.onClick(); await Promise.resolve(); });
    expect(findAction(renderer!, "cancel")).toBeTruthy();
    await act(async () => { findAction(renderer!, "cancel").props.onClick(); await Promise.resolve(); });
    expect(renderer!.root.findByProps({ "data-connection-state": "cancelled" })).toBeTruthy();
    await act(async () => { findAction(renderer!, "connect").props.onClick(); await Promise.resolve(); });
    expect(renderer!.root.findByProps({ "data-connection-state": "failed" })).toBeTruthy();
  });

  it("allows a connected mailbox to be reauthorized with a fresh grant", async () => {
    const transport = connection([{ state: "connected" }]);
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<MailSettingsCard scope={scope()} connection={transport.handle} />); });
    await act(async () => { await Promise.resolve(); });
    act(() => { renderer!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-connection-state": "connected" })).toBeTruthy();
    await act(async () => { findAction(renderer!, "reconnect").props.onClick(); await Promise.resolve(); });
    expect(transport.calls).toContainEqual({ endpoint: "start", payload: { force: true } });
  });

  it("edits and saves MCP, issuer, and callback connection settings together", async () => {
    const mutations: unknown[][] = [];
    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<MailSettingsCard scope={editableScope(mutations)} connection={connection([{ state: "idle" }]).handle} />); });
    await act(async () => { await Promise.resolve(); });
    act(() => { renderer!.root.findByProps({ "aria-expanded": false }).props.onClick(); });
    const labels = renderer!.root.findAll((node) => node.type === "label").map((node) => node.children.join(""));
    expect(labels).toEqual(expect.arrayContaining(["MCP endpoint", "OAuth issuer", "OAuth callback URL"]));
    const endpoint = renderer!.root.find((node) => typeof node.props.id === "string" && node.props.id.endsWith("-endpoint"));
    act(() => { endpoint.props.onChange({ target: { value: "https://mail.changed.test/mcp" } }); });
    await act(async () => { findAction(renderer!, "save").props.onClick(); await Promise.resolve(); });
    expect(mutations).toEqual([[
      { op: "set", path: ["mailboxAddress"], value: "agent@example.com" },
      { op: "set", path: ["upstreamEndpoint"], value: "https://mail.changed.test/mcp" },
      { op: "set", path: ["oauthAuthorizationServer"], value: "https://login.example.test" },
      { op: "set", path: ["oauthCallbackUrl"], value: "http://127.0.0.1:3080/oauth/dsh-mail/callback" }
    ]]);
  });
});
