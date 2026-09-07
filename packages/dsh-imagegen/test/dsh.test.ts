import {
  DEFAULT_BRIDGE_URL,
  MAX_BRIDGE_JSON_BYTES,
} from "@lamplitisles/imagegen-core";
import { Context, Service } from "@deepseek-ai/cordis";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAMESPACE,
  GENERATED_IMAGES_DIRECTORY,
  apply,
  generateWithDsh,
  inject,
  validOrDefault,
  writeGeneratedImage,
  type DshAttachments,
  type DshFileSystem,
} from "../src/index.js";
import {
  bridgeUrlFromSnapshot,
  decodeSettings,
  saveBridgeUrl,
  syncBridgeUrlDraft,
} from "../src/client.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

type Target = { targetKey: string };

class MemorySettingsProvider extends SettingsProvider {
  readonly writable = true;

  constructor(
    ctx: Context,
    private readonly storedDocument: Record<string, unknown>,
  ) {
    super(ctx);
  }

  protected async load(): Promise<Record<string, unknown>> {
    return this.storedDocument;
  }

  protected async persist(): Promise<void> {}
}

function fakeFileSystem(
  options: {
    outside?: boolean;
    type?: string;
    bytes?: Uint8Array;
    processPath?: string;
  } = {},
): DshFileSystem & { limits: number[]; processPaths: string[] } {
  const limits: number[] = [];
  const processPaths: string[] = [];
  return {
    limits,
    processPaths,
    async resolve(path, resolveOptions) {
      if (path === "/workspace") return { targetKey: "/workspace" };
      if (options.outside && path === "link.png")
        return { targetKey: "/outside/secret.png" };
      return { targetKey: `${resolveOptions?.cwd ?? ""}/${path}` };
    },
    contains(parent, child) {
      return (child as Target).targetKey.startsWith(
        `${(parent as Target).targetKey}/`,
      );
    },
    async stat() {
      return { type: options.type ?? "file" };
    },
    async readBytes(_target, _signal, maxBytes) {
      limits.push(maxBytes);
      return options.bytes ?? png;
    },
    processPath(target) {
      const path = options.processPath ?? (target as Target).targetKey;
      processPaths.push(path);
      return path;
    },
  };
}

function fakeAttachments(): DshAttachments & {
  saved: unknown[];
  validated: number;
} {
  const saved: unknown[] = [];
  let validated = 0;
  return {
    saved,
    get validated() {
      return validated;
    },
    async validateImage() {
      validated += 1;
    },
    async saveImage(input) {
      const attachment = {
        attachmentId: "result",
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      } as Awaited<ReturnType<DshAttachments["saveImage"]>>;
      saved.push(attachment);
      return attachment;
    },
  };
}

function bridgeFetch(
  calls: Array<{ url: string; init: RequestInit | undefined }>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ image_url: "data:image/png;base64,iVBORw0KGgoA" }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("DSH image adapter", () => {
  it("registers a persisted non-string bridge URL with the default fallback", async () => {
    const context = new Context();
    const settings = new MemorySettingsProvider(context, {
      [SETTINGS_NAMESPACE]: { bridgeUrl: 42 },
    });
    const initialization = settings[Service.init]();
    const cleanup = await initialization.next();
    await initialization.next();
    try {
      apply({
        attachments: fakeAttachments(),
        fs: fakeFileSystem(),
        settings,
        tools: { register() {} },
      } as any);

      expect(settings.get(SETTINGS_NAMESPACE)).toEqual({
        bridgeUrl: DEFAULT_BRIDGE_URL,
      });
      expect(validOrDefault("unsafe/path")).toBe(DEFAULT_BRIDGE_URL);
    } finally {
      if (typeof cleanup.value === "function") await cleanup.value();
    }
  });

  it("edits workspace-relative images, saves a workspace PNG, and returns a durable native result", async () => {
    const fs = fakeFileSystem();
    const attachments = fakeAttachments();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const writes: Array<{ path: string; data: Uint8Array; cwd: string }> = [];
    const controller = new AbortController();

    const result = await generateWithDsh(
      { prompt: "make it watercolor", images: ["source.png"] },
      {
        signal: controller.signal,
        agent: { session: { header: { cwd: "/workspace" } } },
      },
      {
        fs,
        attachments,
        fetch: bridgeFetch(calls),
        getBridgeUrl: () => "https://bridge.example/",
        writeGeneratedImage: async (path, data, _fs, cwd) => {
          writes.push({ path, data, cwd });
        },
      },
    );

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      prompt: "make it watercolor",
      images: ["data:image/png;base64,iVBORw0KGgoA"],
    });
    expect(calls[0]?.url).toBe("https://bridge.example/codex/images");
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(attachments.validated).toBe(1);
    expect(attachments.saved).toHaveLength(1);
    expect(result.attachment).toEqual({
      attachmentId: "result",
      mediaType: "image/png",
      bytes: png.byteLength,
      width: 1,
      height: 1,
      name: "kepos-image.png",
    });
    expect(result.path).toMatch(
      new RegExp(`^${GENERATED_IMAGES_DIRECTORY}/.+\\.png$`),
    );
    expect(result.message).toBe(`Generated image saved to ${result.path}.`);
    expect(writes).toEqual([
      { path: result.path, data: png, cwd: "/workspace" },
    ]);
    expect(fs.limits[0]).toBeGreaterThan(png.byteLength);
  });

  it("accepts five sources, omits sources for generation, and rejects a sixth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const services = {
      fs: fakeFileSystem(),
      attachments: fakeAttachments(),
      fetch: bridgeFetch(calls),
      getBridgeUrl: () => DEFAULT_BRIDGE_URL,
      writeGeneratedImage: async () => undefined,
    };
    const exec = { agent: { session: { header: { cwd: "/workspace" } } } };

    await generateWithDsh(
      { prompt: "edit", images: ["1.png", "2.png", "3.png", "4.png", "5.png"] },
      exec,
      services,
    );
    expect(JSON.parse(String(calls[0]?.init?.body)).images).toHaveLength(5);
    await generateWithDsh({ prompt: "generate" }, exec, services);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      prompt: "generate",
    });
    await expect(
      generateWithDsh(
        {
          prompt: "edit",
          images: ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"],
        },
        exec,
        services,
      ),
    ).rejects.toThrow("between one and five");
    await expect(
      generateWithDsh({ prompt: "   " }, {}, services),
    ).rejects.toThrow("nonblank");
  });

  it("fails source boundary violations without exposing host paths", async () => {
    const baseServices = {
      attachments: fakeAttachments(),
      fetch: bridgeFetch([]),
      getBridgeUrl: () => DEFAULT_BRIDGE_URL,
      writeGeneratedImage: async () => undefined,
    };
    const exec = { agent: { session: { header: { cwd: "/workspace" } } } };
    const failures = [
      generateWithDsh({ prompt: "edit", images: ["/etc/passwd"] }, exec, {
        ...baseServices,
        fs: fakeFileSystem(),
      }),
      generateWithDsh({ prompt: "edit", images: ["link.png"] }, exec, {
        ...baseServices,
        fs: fakeFileSystem({ outside: true }),
      }),
      generateWithDsh({ prompt: "edit", images: ["pipe.png"] }, exec, {
        ...baseServices,
        fs: fakeFileSystem({ type: "other" }),
      }),
      generateWithDsh({ prompt: "edit", images: ["source.txt"] }, exec, {
        ...baseServices,
        fs: fakeFileSystem(),
      }),
      generateWithDsh({ prompt: "edit", images: ["source.png"] }, exec, {
        ...baseServices,
        fs: fakeFileSystem({
          bytes: new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]),
        }),
      }),
      generateWithDsh(
        { prompt: "edit", images: ["source.png"] },
        {},
        {
          ...baseServices,
          fs: fakeFileSystem(),
        },
      ),
    ];

    for (const failure of failures) {
      await expect(failure).rejects.not.toThrow("/workspace");
      await expect(failure).rejects.not.toThrow("/outside");
    }
  });

  it("writes generated bytes under the active workspace path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-imagegen-test-"));
    const output = join(root, GENERATED_IMAGES_DIRECTORY, "result.png");
    try {
      const fs = fakeFileSystem({ processPath: output });
      await writeGeneratedImage(
        `${GENERATED_IMAGES_DIRECTORY}/result.png`,
        png,
        fs,
        "/workspace",
      );
      await expect(readFile(output)).resolves.toEqual(Buffer.from(png));
      expect(fs.processPaths).toEqual([output]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before a read when the dynamic bridge budget is exhausted", async () => {
    const fs = fakeFileSystem();
    await expect(
      generateWithDsh(
        { prompt: "x".repeat(MAX_BRIDGE_JSON_BYTES), images: ["source.png"] },
        { agent: { session: { header: { cwd: "/workspace" } } } },
        {
          fs,
          attachments: fakeAttachments(),
          fetch: bridgeFetch([]),
          getBridgeUrl: () => DEFAULT_BRIDGE_URL,
          writeGeneratedImage: async () => undefined,
        },
      ),
    ).rejects.toThrow("too large");
    expect(fs.limits).toEqual([]);
  });

  it("registers a closed DSH schema with a supported native attachment result", async () => {
    let tool: any;
    const context = {
      attachments: fakeAttachments(),
      fs: fakeFileSystem(),
      settings: {
        register(namespace: unknown) {
          expect(namespace).toBe(SETTINGS_NAMESPACE);
          return { get: () => ({ bridgeUrl: "not a URL" }) };
        },
      },
      tools: {
        register(definition: unknown) {
          tool = definition;
        },
      },
    };
    apply(context);
    expect(inject).toEqual(["attachments", "fs", "settings", "tools"]);
    expect(tool.name).toBe("kepos_image_generate");
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Required nonblank image-generation prompt.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional one to five nonblank paths relative to the active workspace.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(
      validateJsonSchemaValue(tool.parameters, { prompt: "generate" }),
    ).toEqual([]);
    expect(
      validateJsonSchemaValue(tool.parameters, { images: [] }),
    ).not.toEqual([]);
    expect(
      validateJsonSchemaValue(tool.parameters, {
        prompt: "generate",
        unexpected: true,
      }),
    ).not.toEqual([]);
    expect(
      validateJsonSchemaValue(tool.output.schema, {
        attachment: {
          attachmentId: "result",
          mediaType: "image/png",
          bytes: png.byteLength,
          width: 1,
          height: 1,
        },
        message: "Generated image.",
        path: ".dsh/kepos-imagegen/result.png",
      }),
    ).toEqual([]);
    expect(
      validateJsonSchemaValue(tool.output.schema, {
        attachment: { attachmentId: "result" },
        message: "Generated image.",
        path: ".dsh/kepos-imagegen/result.png",
      }),
    ).not.toEqual([]);
    expect(
      tool.output.render(
        {},
        {
          attachment: {
            attachmentId: "x",
            mediaType: "image/png",
            bytes: 1,
            width: 1,
            height: 1,
          },
          path: ".dsh/kepos-imagegen/result.png",
          message: "Generated image saved to .dsh/kepos-imagegen/result.png.",
        },
      ),
    ).toEqual([
      {
        type: "image",
        attachment: {
          attachmentId: "x",
          mediaType: "image/png",
          bytes: 1,
          width: 1,
          height: 1,
        },
      },
      {
        type: "text",
        text: "Generated image saved to .dsh/kepos-imagegen/result.png.",
      },
    ]);
    expect(validOrDefault("not a URL")).toBe(DEFAULT_BRIDGE_URL);

    const writes: string[] = [];
    const scope = {
      getSnapshot: () => ({
        status: "ready" as const,
        value: { bridgeUrl: "https://persisted.example/" },
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: "host" as const,
      }),
      subscribe: () => () => undefined,
      async set(_key: "bridgeUrl", value: string) {
        writes.push(value);
      },
    };
    await expect(saveBridgeUrl(scope, "https://bridge.example/")).resolves.toBe(
      "https://bridge.example",
    );
    await expect(
      saveBridgeUrl(scope, "https://bridge.example/path"),
    ).rejects.toThrow("valid Kepos");
    expect(writes).toEqual(["https://bridge.example"]);
    expect(bridgeUrlFromSnapshot(scope.getSnapshot())).toBe(
      "https://persisted.example",
    );
    expect(decodeSettings({ bridgeUrl: "https://bridge.example/" })).toEqual({
      bridgeUrl: "https://bridge.example",
    });
    expect(decodeSettings({ bridgeUrl: "unsafe/path" })).toEqual({
      bridgeUrl: DEFAULT_BRIDGE_URL,
    });
  });

  it("keeps a staged bridge URL across failed or conflicting snapshot reloads", () => {
    const edited = {
      value: "https://draft.example",
      saved: "https://saved.example",
    };

    expect(syncBridgeUrlDraft(edited, "https://saved.example")).toBe(edited);
    expect(syncBridgeUrlDraft(edited, "https://other.example")).toEqual({
      value: "https://draft.example",
      saved: "https://other.example",
    });
    expect(
      syncBridgeUrlDraft(
        {
          value: "https://saved.example",
          saved: "https://saved.example",
        },
        "https://other.example",
      ),
    ).toEqual({
      value: "https://other.example",
      saved: "https://other.example",
    });
  });
});
