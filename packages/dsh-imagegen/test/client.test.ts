import type { Context } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, SETTINGS_NAMESPACE } from "../src/client.js";

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
      value: { bridgeUrl: "https://bridge.invalid" },
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
        value: { bridgeUrl: "https://bridge.invalid" },
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

  it("constructs a preview from the alpha session attachment and revokes it on unmount", async () => {
    const readAttachment = vi.fn(async () => ({
      ok: true as const,
      value: {
        attachment: imageAttachment,
        data: new Uint8Array([1, 2, 3]),
      },
    }));
    const sessions = {
      binding: vi.fn(() => ({ session: { readAttachment } })),
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
    const readAttachment = vi.fn(() => Promise.reject(new Error("offline")));
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
