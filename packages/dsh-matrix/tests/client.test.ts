import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "../src/client.js";
import { SETTINGS_NAMESPACE } from "../src/constants.js";
import { matrixLabels, matrixZhLabels } from "../src/client/labels.js";
import { MatrixSettingsCard, type WorkspaceSource } from "../src/client/settings-card.js";

describe("client settings registration", () => {
  it("injects the rc.1 workspaces service and passes its live source to the card", () => {
    expect(inject).toContain("workspaces");
    expect(inject).toContain("remote.credentials");
    const workspaceSource = {
      getSnapshot: () => undefined as never,
      subscribe: () => () => undefined
    } as WorkspaceSource;
    const localeRegister = vi.fn();
    const bind = vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => undefined, set: vi.fn(), unset: vi.fn() }));
    let registeredOptions!: Record<string, unknown>;
    let registeredComponent!: unknown;
    const slots = {
      inject: vi.fn((_name: string, factory: () => unknown) => factory()),
      register: vi.fn((options: Record<string, unknown>, component: unknown) => {
        registeredOptions = options;
        registeredComponent = component;
        return () => undefined;
      })
    };
    const context = {
      effect: (execute: () => unknown) => execute(),
      locale: { register: localeRegister },
      settingsScope: { bind },
      connection: { rpc: { call: vi.fn() } },
      remote: { credentials: { describe: vi.fn(), set: vi.fn() } },
      slots,
      workspaces: { list: workspaceSource }
    } as unknown as ClientContext;

    apply(context);

    expect(localeRegister).toHaveBeenCalledWith(SETTINGS_NAMESPACE, expect.objectContaining({ en: matrixLabels, zh: matrixZhLabels }));
    expect(registeredComponent).toBe(MatrixSettingsCard);
    const injected = (registeredOptions.inject as () => Record<string, unknown>)();
    expect(injected.workspaceSource).toBe(workspaceSource);
    expect(injected.scope).toBe(bind.mock.results[0]?.value);
    expect(injected.api).toBeDefined();
    expect(injected.readiness).toBeDefined();
  });
});
