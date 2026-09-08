import type { FileSystem } from "@deepseek-ai/dsh-fs";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { describe, expect, it } from "vitest";
import {
  apply,
  APPLY_PATCH_NAME,
  inject,
  name,
  PROVIDER_ID,
  SETTINGS_NAMESPACE,
  type CodexSettings,
} from "../src/index.js";

const dormant: CodexSettings = {
  enabled: false,
  baseURL: "",
  credentialRef: "",
  models: [],
  transport: "auto",
  maxPatchChars: 4_000_000,
  maxPatchFiles: 64,
  maxPatchFileBytes: 4_000_000,
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
  maxPatchChars: 4_000_000,
  maxPatchFiles: 64,
  maxPatchFileBytes: 4_000_000,
};

type Listener = (...args: any[]) => unknown;

function makeHost(initial: CodexSettings = dormant) {
  const registrations: Array<{
    providers: string[];
    adapter: unknown;
    activeProviders: string[];
    replaced: string[][];
    disposed: boolean;
  }> = [];
  const listeners = new Set<
    (next: CodexSettings, previous: CodexSettings) => void
  >();
  const eventListeners = new Map<string, Set<Listener>>();
  const toolsByName = new Map<string, any>();
  const toolRegistrations: any[] = [];
  const guards: Array<(execution: any) => string | undefined> = [];
  let current = initial;
  let registeredSchema: unknown;
  let registeredOptions: unknown;
  let lifecycle: (() => Promise<void>) | undefined;

  const tools = {
    register(definition: any) {
      toolRegistrations.push(definition);
      toolsByName.set(definition.name, definition);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = toolRegistrations.indexOf(definition);
        if (index >= 0) toolRegistrations.splice(index, 1);
        if (toolsByName.get(definition.name) === definition)
          toolsByName.delete(definition.name);
      };
    },
    get(name: string) {
      return toolsByName.get(name);
    },
    schemas() {
      return [
        schema("run_code"),
        schema(APPLY_PATCH_NAME),
        schema("edit"),
        schema("write"),
        schema("read"),
        schema("shell"),
      ];
    },
    guard(guard: (execution: any) => string | undefined) {
      guards.push(guard);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = guards.indexOf(guard);
        if (index >= 0) guards.splice(index, 1);
      };
    },
  };

  const ctx = {
    credentials: { resolve: async () => ({ value: "unused-test-secret" }) },
    fs: {} as FileSystem,
    get: (key: string) =>
      key === "codeRuntime" ? { language: "typescript" } : undefined,
    tools,
    settings: {
      register: (_namespace: string, schema: unknown, options: unknown) => {
        registeredSchema = schema;
        registeredOptions = options;
        return {
          get: () => current,
          watch: (
            listener: (next: CodexSettings, previous: CodexSettings) => void,
          ) => {
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
    on: (event: string, listener: Listener) => {
      let entries = eventListeners.get(event);
      if (entries === undefined) {
        entries = new Set();
        eventListeners.set(event, entries);
      }
      entries.add(listener);
      return () => entries?.delete(listener) ?? false;
    },
    effect: (factory: () => () => Promise<void>) => {
      lifecycle = factory();
      return () => undefined;
    },
  };

  return {
    ctx,
    registrations,
    tools,
    toolsByName,
    toolRegistrations,
    guards,
    listeners,
    eventListeners,
    get current() {
      return current;
    },
    set current(value: CodexSettings) {
      const previous = current;
      current = value;
      for (const listener of listeners) listener(value, previous);
    },
    registeredSchema: () => registeredSchema,
    registeredOptions: () => registeredOptions,
    dispose: async () => lifecycle?.(),
  };
}

function schema(toolName: string) {
  return {
    name: toolName,
    description: `${toolName} description`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "number" } },
    },
  };
}

function definition(toolName: string) {
  return {
    ...schema(toolName),
    output: { schema: { type: "string" } },
  };
}

async function assemble(
  host: ReturnType<typeof makeHost>,
  agent: { options?: { provider?: string } },
  provider: string,
  directNames = [
    "run_code",
    APPLY_PATCH_NAME,
    "edit",
    "write",
    "read",
    "shell",
  ],
): Promise<PromptAssembly> {
  const listener = [
    ...(host.eventListeners.get("system-prompt/assemble") ?? []),
  ][0];
  if (listener === undefined)
    throw new Error("assembly listener was not registered");
  const assembly: PromptAssembly = {
    sections: [{ name: "tools:sdk", text: "Existing SDK" }],
    contexts: [],
    tools: directNames.map((name) => schema(name)),
    variables: { provider },
  };
  for (const tool of host.tools.schemas()) {
    if (!host.tools.get(tool.name))
      host.toolsByName.set(tool.name, definition(tool.name));
  }
  return (await listener(assembly, { agent, scope: agent }, () =>
    Promise.resolve(assembly),
  )) as PromptAssembly;
}

describe("Codex Host composition", () => {
  it("registers only after opt-in and releases live settings/watchers with the Host lifetime", async () => {
    const host = makeHost();

    expect(name).toBe("dsh-codex-code-mode");
    expect(inject).toEqual([
      "llm",
      "credentials",
      "fs",
      "settings",
      "systemPrompt",
      "tools",
      "sessions",
    ]);
    apply(host.ctx as never);
    expect(host.registeredSchema()).toBeDefined();
    expect(host.registeredOptions()).toMatchObject({
      applies: "live",
      validate: expect.any(Function),
    });
    expect(host.registrations).toHaveLength(0);
    expect(host.toolRegistrations).toHaveLength(0);

    host.current = active;
    expect(host.registrations).toHaveLength(1);
    expect(host.registrations[0]).toMatchObject({
      providers: [PROVIDER_ID],
      activeProviders: [PROVIDER_ID],
      disposed: false,
    });
    expect(host.toolRegistrations.map((tool) => tool.name)).toEqual([
      APPLY_PATCH_NAME,
    ]);

    host.current = dormant;
    expect(host.registrations[0]?.replaced).toEqual([[]]);
    expect(host.toolRegistrations).toHaveLength(0);

    host.current = active;
    expect(host.registrations[0]?.replaced).toEqual([[], [PROVIDER_ID]]);
    expect(host.toolRegistrations).toHaveLength(1);

    await host.dispose();
    expect(host.registrations[0]?.disposed).toBe(true);
    expect(host.registrations[0]?.activeProviders).toEqual([]);
    expect(host.listeners).toHaveLength(0);
    expect(host.eventListeners.get("session/disposed")).toHaveLength(0);
    expect(host.guards).toHaveLength(0);
    expect(host.toolRegistrations).toHaveLength(0);
    expect(SETTINGS_NAMESPACE).toBe("dsh-codex-code-mode");
  });

  it("isolates the patch route, filters the SDK, and captures the provider for an active step", async () => {
    const host = makeHost(active);
    apply(host.ctx as never);
    const agent: { options: { provider: string } } = {
      options: { provider: PROVIDER_ID },
    };
    const assembled = await assemble(host, agent, PROVIDER_ID);

    expect(assembled.tools.map((tool) => tool.name)).toEqual([
      "run_code",
      APPLY_PATCH_NAME,
    ]);
    const sdk = assembled.sections.find(
      (section) => section.name === "tools:sdk",
    )?.text;
    expect(sdk).toContain("read");
    expect(sdk).toContain("shell");
    expect(sdk).not.toContain("edit");
    expect(sdk).not.toContain("write");
    expect(sdk).not.toContain(APPLY_PATCH_NAME);

    const guard = host.guards[0];
    if (guard === undefined) throw new Error("guard was not registered");
    expect(
      guard({ name: APPLY_PATCH_NAME, agent, parent: undefined }),
    ).toBeUndefined();
    expect(guard({ name: "read", agent, parent: undefined })).toContain(
      "only run_code and apply_patch",
    );
    expect(guard({ name: "edit", agent, parent: Symbol() })).toContain(
      "only run_code and apply_patch",
    );
    expect(guard({ name: "read", agent, parent: Symbol() })).toBeUndefined();

    agent.options.provider = "other-provider";
    expect(guard({ name: "read", agent, parent: undefined })).toContain(
      "only run_code and apply_patch",
    );
    expect(
      guard({ name: APPLY_PATCH_NAME, agent, parent: undefined }),
    ).toBeUndefined();

    const otherAgent = { options: { provider: "other-provider" } };
    expect(guard({ name: APPLY_PATCH_NAME, agent: otherAgent })).toContain(
      "available only on the selected Codex",
    );
    expect(guard({ name: "read", agent: otherAgent })).toBeUndefined();

    await host.dispose();
  });

  it("leaves strict PTC and every assembly untouched while dormant", async () => {
    const host = makeHost();
    apply(host.ctx as never);
    const agent = { options: { provider: "other-provider" } };
    const original = {
      sections: [{ name: "tools:sdk", text: "unrelated SDK" }],
      contexts: [],
      tools: [schema("run_code")],
      variables: { provider: "other-provider" },
    } as PromptAssembly;
    const listener = [
      ...(host.eventListeners.get("system-prompt/assemble") ?? []),
    ][0];
    if (listener === undefined)
      throw new Error("assembly listener was not registered");
    const result = await listener(original, { agent, scope: agent }, () =>
      Promise.resolve(original),
    );
    expect(result).toBe(original);
    const guard = host.guards[0];
    if (guard === undefined) throw new Error("guard was not registered");
    expect(guard({ name: APPLY_PATCH_NAME, agent })).toBeUndefined();
    await host.dispose();
  });

  it("derives an enabled strict-PTC unrelated SDK from visible schemas", async () => {
    const host = makeHost(active);
    apply(host.ctx as never);
    const agent = { options: { provider: "other-provider" } };
    const assembled = await assemble(host, agent, "other-provider", [
      "run_code",
    ]);
    expect(assembled.tools.map((tool) => tool.name)).toEqual(["run_code"]);
    const sdk = assembled.sections.find(
      (section) => section.name === "tools:sdk",
    )?.text;
    expect(sdk).toContain("read");
    expect(sdk).toContain("shell");
    expect(sdk).not.toContain(APPLY_PATCH_NAME);
    await host.dispose();
  });
});
