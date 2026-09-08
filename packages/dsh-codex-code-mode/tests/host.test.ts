import { describe, expect, it } from "vitest";
import {
  apply,
  name,
  inject,
  SETTINGS_NAMESPACE,
  PROVIDER_ID,
  type CodexSettings,
} from "../src/index.js";

const dormant: CodexSettings = {
  enabled: false,
  baseURL: "",
  credentialRef: "",
  models: [],
  transport: "auto",
};

const active: CodexSettings = {
  enabled: true,
  baseURL: "https://codex-gateway.test",
  credentialRef: "CODEX_API_KEY",
  models: [
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      contextWindow: 262_144,
      maxTokens: 32_768,
    },
  ],
  transport: "auto",
};

describe("Codex Host composition", () => {
  it("registers only after opt-in and releases live settings/watchers with the Host lifetime", async () => {
    const registrations: Array<{
      providers: string[];
      adapter: unknown;
      activeProviders: string[];
      replaced: string[][];
      disposed: boolean;
    }> = [];
    const listeners = new Set<(next: CodexSettings) => void>();
    const sessionListeners = new Set<(session: { id: string }) => void>();
    let current = dormant;
    let registeredSchema: unknown;
    let registeredOptions: unknown;
    let lifecycle: (() => Promise<void>) | undefined;
    const ctx = {
      credentials: { resolve: async () => ({ value: "unused-test-secret" }) },
      settings: {
        register: (_namespace: string, schema: unknown, options: unknown) => {
          registeredSchema = schema;
          registeredOptions = options;
          return {
            get: () => current,
            watch: (listener: (next: CodexSettings) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          };
        },
      },
      llm: {
        registerAdapter: (providers: string[], adapter: unknown) => {
          const entry = {
            providers,
            adapter,
            activeProviders: [...providers],
            replaced: [] as string[][],
            disposed: false,
          };
          registrations.push(entry);
          const dispose = Object.assign(
            () => {
              entry.disposed = true;
              entry.activeProviders = [];
            },
            {
              replace: (next: string[]) => {
                entry.replaced.push([...next]);
                entry.activeProviders = [...next];
              },
            },
          );
          return dispose;
        },
      },
      on: (_event: string, listener: (session: { id: string }) => void) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      effect: (factory: () => () => Promise<void>) => {
        lifecycle = factory();
        return () => undefined;
      },
    };

    expect(name).toBe("dsh-codex-code-mode");
    expect(inject).toEqual(["llm", "credentials", "settings", "sessions"]);
    apply(ctx as never);
    expect(registeredSchema).toBeDefined();
    expect(registeredOptions).toMatchObject({
      applies: "live",
      validate: expect.any(Function),
    });
    expect(registrations).toHaveLength(0);

    current = active;
    for (const listener of listeners) listener(current);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      providers: [PROVIDER_ID],
      activeProviders: [PROVIDER_ID],
      disposed: false,
    });
    const resolveProvider = async (): Promise<readonly unknown[]> => {
      const entry = registrations[0];
      if (entry === undefined || !entry.activeProviders.includes(PROVIDER_ID))
        throw new Error("provider route is not registered");
      return (
        entry.adapter as {
          listModels(provider: string): Promise<readonly unknown[]>;
        }
      ).listModels(PROVIDER_ID);
    };
    await expect(resolveProvider()).resolves.toHaveLength(1);

    current = dormant;
    for (const listener of listeners) listener(current);
    expect(registrations[0]?.replaced).toEqual([[]]);
    await expect(resolveProvider()).rejects.toThrow(
      "provider route is not registered",
    );

    current = active;
    for (const listener of listeners) listener(current);
    expect(registrations[0]?.replaced).toEqual([[], [PROVIDER_ID]]);
    await expect(resolveProvider()).resolves.toHaveLength(1);

    await lifecycle?.();
    expect(registrations[0]?.disposed).toBe(true);
    expect(registrations[0]?.activeProviders).toEqual([]);
    expect(listeners).toHaveLength(0);
    expect(sessionListeners).toHaveLength(0);
    expect(SETTINGS_NAMESPACE).toBe("dsh-codex-code-mode");
  });
});
