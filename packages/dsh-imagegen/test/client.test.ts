import type { Context } from "@deepseek-ai/cordis";
import type { SettingsPathOpView } from "@deepseek-ai/dsh-api-remotes/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_GENERATION_MODEL,
  type ImagegenSettings,
} from "../src/constants.js";
import {
  apply,
  SETTINGS_NAMESPACE,
  type SettingsScope,
} from "../src/client.js";

const imageAttachment = {
  attachmentId: "attachment-1",
  mediaType: "image/png" as const,
  bytes: 3,
  width: 1,
  height: 1,
  name: "generated.png",
};

function resultBlock() {
  return {
    kind: "tool-result" as const,
    seq: 1,
    time: 1,
    callId: "call-1",
    call: { name: "kepos_image_generate", argsRaw: "{}" },
    callTime: 1,
    content: [
      { type: "image" as const, attachment: imageAttachment },
      {
        type: "text" as const,
        text: "Generated image saved to .dsh/kepos-imagegen/result.png.",
      },
    ],
    isError: false,
    subCalls: [],
  };
}

function registeredToolView(sessions: Pick<ISessions, "binding">) {
  let toolView: ((props: unknown) => unknown) | undefined;
  const scope = {
    getSnapshot: () => ({
      status: "ready" as const,
      value: {
        bridgeUrl: "https://bridge.invalid",
        generationModel: DEFAULT_GENERATION_MODEL,
        editModel: DEFAULT_EDIT_MODEL,
      },
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: "host" as const,
    }),
    subscribe: () => () => undefined,
    set: async () => undefined,
  };
  apply({
    effect() {},
    settingsScope: { bind: () => scope },
    sessions,
    slots: {
      inject(_name: string, callback: () => unknown) {
        callback();
      },
      register(
        spec: { name: string; key: string },
        content: unknown,
      ): () => void {
        if (
          spec.name === "tool.call.toolview" &&
          spec.key === "kepos_image_generate"
        ) {
          toolView = content as (props: unknown) => unknown;
        }
        return () => undefined;
      },
    },
  } as unknown as Context);
  if (toolView === undefined) throw new Error("tool view was not registered");
  return toolView;
}

function renderToolView(
  toolView: (props: unknown) => unknown,
): ReactTestRenderer {
  return create(
    toolView({
      callId: "call-1",
      toolName: "kepos_image_generate",
      block: resultBlock(),
      sessionId: "session-1",
      cwd: "/workspace",
      openFile: () => undefined,
    }) as React.ReactElement,
  );
}

function renderedText(renderer: ReactTestRenderer): string {
  const visit = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(visit).join("");
    if (typeof node !== "object" || node === null) return "";
    return visit((node as { children?: unknown }).children);
  };
  return visit(renderer.toJSON());
}

function imagegenSettings(
  overrides: Partial<ImagegenSettings> = {},
): ImagegenSettings {
  return {
    bridgeUrl: "https://bridge.invalid",
    generationModel: DEFAULT_GENERATION_MODEL,
    editModel: DEFAULT_EDIT_MODEL,
    ...overrides,
  };
}

function registeredSettingsCard(
  scope: SettingsScope,
): () => React.ReactElement {
  let settingsCard: (() => React.ReactElement) | undefined;
  apply({
    effect() {},
    settingsScope: { bind: () => scope },
    sessions: { binding: () => undefined },
    slots: {
      inject(_name: string, callback: () => unknown) {
        callback();
      },
      register(spec: { name: string; key: string }, content: unknown) {
        if (
          spec.name === "settings.plugin.item" &&
          spec.key === SETTINGS_NAMESPACE
        ) {
          settingsCard = content as () => React.ReactElement;
        }
        return () => undefined;
      },
    },
  } as unknown as Context);
  if (settingsCard === undefined) {
    throw new Error("settings card was not registered");
  }
  return settingsCard;
}

function settingsScopeFixture({
  value = imagegenSettings(),
  writable = true,
  status = "ready" as const,
  rejectMutation,
}: {
  value?: ImagegenSettings;
  writable?: boolean;
  status?: "loading" | "ready" | "unavailable";
  rejectMutation?: Error;
} = {}): {
  scope: SettingsScope;
  mutations: SettingsPathOpView[][];
  update(value: ImagegenSettings): void;
} {
  let snapshot = {
    status,
    value: status === "ready" ? value : undefined,
    base: {},
    user: {},
    revision: 1,
    writable,
    mode: "host" as const,
  };
  const listeners = new Set<() => void>();
  const mutations: SettingsPathOpView[][] = [];
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: async () => undefined,
    mutate: async (ops: readonly SettingsPathOpView[]) => {
      mutations.push([...ops]);
      if (rejectMutation !== undefined) throw rejectMutation;
      const next = { ...snapshot.value } as ImagegenSettings;
      for (const op of ops) {
        if (op.op !== "set" || op.path.length !== 1) continue;
        const field = op.path[0] as keyof ImagegenSettings;
        next[field] = op.value as ImagegenSettings[typeof field];
      }
      snapshot = {
        ...snapshot,
        value: next,
        revision: snapshot.revision + 1,
      };
      for (const listener of listeners) listener();
    },
  } as SettingsScope;
  return {
    scope,
    mutations,
    update(nextValue) {
      snapshot = {
        ...snapshot,
        status: "ready",
        value: nextValue,
        revision: snapshot.revision + 1,
      };
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DSH durable image preview", () => {
  it("registers the native settings card and image tool view", () => {
    const registrations: Array<{ name: string; key: string }> = [];
    let namespace: string | undefined;
    const scope = {
      getSnapshot: () => ({
        status: "ready" as const,
        value: {
          bridgeUrl: "https://bridge.invalid",
          generationModel: DEFAULT_GENERATION_MODEL,
          editModel: DEFAULT_EDIT_MODEL,
        },
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: "host" as const,
      }),
      subscribe: () => () => undefined,
      set: async () => undefined,
    };

    apply({
      effect() {},
      settingsScope: {
        bind(spec: { namespace?: string }) {
          namespace = spec.namespace;
          return scope;
        },
      },
      sessions: { binding: () => undefined },
      slots: {
        inject(_name: string, callback: () => unknown) {
          callback();
        },
        register(spec: { name: string; key: string }) {
          registrations.push(spec);
          return () => undefined;
        },
      },
    } as unknown as Context);

    expect(namespace).toBe(SETTINGS_NAMESPACE);
    expect(registrations).toEqual(
      expect.arrayContaining([
        { name: "settings.plugin.item", key: SETTINGS_NAMESPACE },
        { name: "tool.call.toolview", key: "kepos_image_generate" },
      ]),
    );
  });

  it("renders model defaults and saves changed models as one settings mutation", async () => {
    const fixture = settingsScopeFixture();
    const settingsCard = registeredSettingsCard(fixture.scope);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(settingsCard());
    });

    let header = renderer.root.findByType("button");
    expect(header.props["aria-expanded"]).toBe(false);
    await act(async () => {
      header.props.onClick();
    });

    let inputs = renderer.root.findAllByType("input");
    expect(inputs.map((input) => input.props.value)).toEqual([
      "https://bridge.invalid",
      DEFAULT_GENERATION_MODEL,
      DEFAULT_EDIT_MODEL,
    ]);
    expect(
      renderer.root.findAllByType("label").map((label) => label.children[0]),
    ).toEqual(["Kepos bridge address", "Generation model", "Editing model"]);

    await act(async () => {
      inputs[1]!.props.onChange({
        target: { value: "  configured-generation  " },
      });
      inputs[2]!.props.onChange({ target: { value: "configured-edit" } });
    });
    const save = renderer.root.findAllByType("button").at(-1)!;
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
    });

    expect(fixture.mutations).toEqual([
      [
        {
          op: "set",
          path: ["generationModel"],
          value: "configured-generation",
        },
        { op: "set", path: ["editModel"], value: "configured-edit" },
      ],
    ]);
    header = renderer.root.findByType("button");
    expect(header.props["aria-expanded"]).toBe(false);
    renderer.unmount();
  });

  it("associates invalid model feedback and retains drafts after a failed save", async () => {
    const fixture = settingsScopeFixture({
      rejectMutation: new Error("settings connection failed"),
    });
    const settingsCard = registeredSettingsCard(fixture.scope);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(settingsCard());
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });

    let inputs = renderer.root.findAllByType("input");
    await act(async () => {
      inputs[1]!.props.onChange({ target: { value: "   " } });
    });
    let save = renderer.root.findAllByType("button").at(-1)!;
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
    });
    inputs = renderer.root.findAllByType("input");
    expect(fixture.mutations).toEqual([]);
    expect(inputs[1]!.props["aria-invalid"]).toBe(true);
    expect(inputs[1]!.props["aria-describedby"]).toContain("error");
    expect(renderedText(renderer)).toContain("nonblank image model");

    await act(async () => {
      inputs[1]!.props.onChange({ target: { value: "staged-generation" } });
    });
    save = renderer.root.findAllByType("button").at(-1)!;
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
    });
    inputs = renderer.root.findAllByType("input");
    expect(inputs[1]!.props.value).toBe("staged-generation");
    expect(
      renderer.root.findAllByType("button")[0]!.props["aria-expanded"],
    ).toBe(true);
    expect(renderedText(renderer)).toContain("settings connection failed");
    renderer.unmount();
  });

  it("hides unavailable cards, disables read-only writes, and keeps dirty fields during reload", async () => {
    const unavailable = settingsScopeFixture({ status: "unavailable" });
    const unavailableCard = registeredSettingsCard(unavailable.scope);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(unavailableCard());
    });
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();

    const readOnly = settingsScopeFixture({ writable: false });
    const readOnlyCard = registeredSettingsCard(readOnly.scope);
    await act(async () => {
      renderer = create(readOnlyCard());
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    expect(renderedText(renderer)).toContain("read-only");
    expect(
      renderer.root
        .findAllByType("input")
        .every((input) => input.props.disabled),
    ).toBe(true);
    expect(renderer.root.findAllByType("button").at(-1)!.props.disabled).toBe(
      true,
    );
    renderer.unmount();

    const changing = settingsScopeFixture();
    const changingCard = registeredSettingsCard(changing.scope);
    await act(async () => {
      renderer = create(changingCard());
    });
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    let inputs = renderer.root.findAllByType("input");
    await act(async () => {
      inputs[1]!.props.onChange({ target: { value: "local-generation" } });
    });
    await act(async () => {
      changing.update(
        imagegenSettings({
          bridgeUrl: "https://reloaded.invalid",
          generationModel: "remote-generation",
          editModel: "remote-edit",
        }),
      );
      await Promise.resolve();
    });
    inputs = renderer.root.findAllByType("input");
    expect(inputs.map((input) => input.props.value)).toEqual([
      "https://reloaded.invalid",
      "local-generation",
      "remote-edit",
    ]);
    renderer.unmount();
  });

  it("constructs a preview from the alpha session attachment and revokes it on unmount", async () => {
    const readAttachment = vi.fn<
      () => Promise<{
        ok: true;
        value: { attachment: typeof imageAttachment; data: Uint8Array };
      }>
    >(async () => ({
      ok: true,
      value: {
        attachment: imageAttachment,
        data: new Uint8Array([1, 2, 3]),
      },
    }));
    const sessions = {
      binding: vi.fn<
        () => { session: { readAttachment: typeof readAttachment } }
      >(() => ({ session: { readAttachment } })),
    } as unknown as Pick<ISessions, "binding">;
    const createdBlobs: Blob[] = [];
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        createdBlobs.push(blob as Blob);
        return "blob:kepos-preview";
      });
    const revokeUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    const toolView = registeredToolView(sessions);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = renderToolView(toolView);
      await Promise.resolve();
    });

    expect(sessions.binding).toHaveBeenCalledWith("session-1");
    expect(readAttachment).toHaveBeenCalledWith("attachment-1");
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(createdBlobs[0]?.type).toBe("image/png");
    expect(createdBlobs[0]?.size).toBe(3);
    expect(renderer.root.findByType("img").props).toMatchObject({
      src: "blob:kepos-preview",
      alt: "generated.png",
    });

    await act(async () => renderer.unmount());
    expect(revokeUrl).toHaveBeenCalledWith("blob:kepos-preview");
  });

  it("shows the preview failure when the alpha attachment read is rejected", async () => {
    const readAttachment = vi.fn<() => Promise<never>>(() =>
      Promise.reject(new Error("offline")),
    );
    const sessions = {
      binding: () => ({ session: { readAttachment } }),
    } as unknown as Pick<ISessions, "binding">;

    const toolView = registeredToolView(sessions);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = renderToolView(toolView);
      await Promise.resolve();
    });

    expect(readAttachment).toHaveBeenCalledWith("attachment-1");
    expect(renderedText(renderer)).toContain(
      "Could not load the image preview.",
    );
    await act(async () => renderer.unmount());
  });
});
