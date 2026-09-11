import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_GENERATION_MODEL,
  type ImagegenSettings,
} from "../src/constants.js";
import { DEFAULT_BRIDGE_URL, MAX_BRIDGE_JSON_BYTES } from "../src/core.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { SettingsProvider } from "@deepseek-ai/dsh-settings";
import {
  lstat as lstatPath,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAMESPACE,
  GENERATED_IMAGES_DIRECTORY,
  SettingsSchema,
  apply,
  generateWithDsh,
  inject,
  normalizeImagegenSettings,
  normalizeImageFilename,
  validOrDefault,
  writeGeneratedImage,
  type DshAttachments,
  type DshFileSystem,
} from "../src/index.js";
import {
  decodeSettings,
  imagegenSettingsFromSnapshot,
  saveSetting,
  syncImagegenSettingsDraft,
} from "../src/client.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function imagegenSettings(
  overrides: Partial<ImagegenSettings> = {},
): ImagegenSettings {
  return {
    bridgeUrl: DEFAULT_BRIDGE_URL,
    generationModel: DEFAULT_GENERATION_MODEL,
    editModel: DEFAULT_EDIT_MODEL,
    ...overrides,
  };
}

type Target = { targetKey: string };

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string")
    throw new Error("test request body was not a string");
  return init.body;
}

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
    lstatType?: string;
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
    async lstat() {
      return options.lstatType === undefined
        ? undefined
        : { type: options.lstatType };
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

function stubWriter(filename: string): Promise<string> {
  return Promise.resolve(`${GENERATED_IMAGES_DIRECTORY}/${filename}`);
}

function localFileSystem(root: string): DshFileSystem {
  const targetPath = (path: string, cwd = root) => resolve(cwd, path);
  return {
    async resolve(path, options) {
      return { targetKey: targetPath(path, options?.cwd ?? root) };
    },
    contains(parent, child) {
      const childRelative = relative(
        (parent as Target).targetKey,
        (child as Target).targetKey,
      );
      return (
        childRelative === "" ||
        (!childRelative.startsWith("..") && !isAbsolute(childRelative))
      );
    },
    async lstat(path, options) {
      try {
        const info = await lstatPath(targetPath(path, options?.cwd ?? root));
        return {
          type: info.isSymbolicLink()
            ? "symlink"
            : info.isFile()
              ? "file"
              : info.isDirectory()
                ? "directory"
                : "other",
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
    },
    async stat() {
      throw new Error("stat is not used by output-only test filesystem");
    },
    async readBytes() {
      throw new Error("readBytes is not used by output-only test filesystem");
    },
    processPath(target) {
      return (target as Target).targetKey;
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
    calls.push({ url: requestUrl(url), init });
    return new Response(
      JSON.stringify({ image_url: "data:image/png;base64,iVBORw0KGgoA" }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("DSH image adapter", () => {
  it("registers persisted settings with bridge and model defaults", async () => {
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
        generationModel: DEFAULT_GENERATION_MODEL,
        editModel: DEFAULT_EDIT_MODEL,
      });
      expect(validOrDefault("unsafe/path")).toBe(DEFAULT_BRIDGE_URL);
      expect(SettingsSchema({} as never)).toEqual(imagegenSettings());
      expect(
        SettingsSchema({
          bridgeUrl: "https://bridge.example/",
          generationModel: "  fast-model  ",
          editModel: "  precise-model  ",
        } as never),
      ).toEqual(
        imagegenSettings({
          bridgeUrl: "https://bridge.example/",
          generationModel: "fast-model",
          editModel: "precise-model",
        }),
      );
      expect(() => SettingsSchema({ generationModel: "   " } as never)).toThrow(
        "string",
      );
      expect(() => SettingsSchema({ editModel: 42 } as never)).toThrow(
        "string",
      );
    } finally {
      if (typeof cleanup.value === "function") await cleanup.value();
    }
  });

  it("normalizes descriptive Unicode filenames and rejects unsafe names", () => {
    expect(normalizeImageFilename("  海边日落  ")).toBe("海边日落.png");
    expect(normalizeImageFilename("beach-sunset.PNG")).toBe("beach-sunset.png");
    expect(normalizeImageFilename("beach-sunset")).toBe("beach-sunset.png");

    for (const filename of [
      undefined,
      "",
      "   ",
      ".",
      "..",
      "../escape",
      "nested/name",
      "nested\\name",
      "unsafe?.png",
      "unsafe\nname.png",
      "beach.jpg",
      "CON.png",
      "name .png",
    ]) {
      expect(() => normalizeImageFilename(filename)).toThrow(
        /filename|PNG|device name/u,
      );
    }
  });

  it("rejects missing or invalid filenames before calling the image provider", async () => {
    let calls = 0;
    const services = {
      fs: fakeFileSystem(),
      attachments: fakeAttachments(),
      fetch: (async () => {
        calls += 1;
        return new Response();
      }) as typeof fetch,
      getSettings: () => imagegenSettings(),
      writeGeneratedImage: stubWriter,
    };

    for (const args of [
      { prompt: "generate" },
      { prompt: "generate", filename: " " },
      { prompt: "generate", filename: "../escape.png" },
      { prompt: "generate", filename: "photo.jpg" },
    ]) {
      await expect(
        generateWithDsh(
          args,
          { agent: { session: { header: { cwd: "/workspace" } } } },
          services,
        ),
      ).rejects.toThrow(/filename|PNG/u);
    }
    expect(calls).toBe(0);
  });

  it("edits workspace-relative images, saves a workspace PNG, and returns a durable native result", async () => {
    const fs = fakeFileSystem();
    const attachments = fakeAttachments();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const writes: Array<{ path: string; data: Uint8Array; cwd: string }> = [];
    const controller = new AbortController();

    const result = await generateWithDsh(
      {
        prompt: "make it watercolor",
        filename: "  watercolor-edit.PNG  ",
        images: ["source.png"],
      },
      {
        signal: controller.signal,
        agent: { session: { header: { cwd: "/workspace" } } },
      },
      {
        fs,
        attachments,
        fetch: bridgeFetch(calls),
        getSettings: () =>
          imagegenSettings({
            bridgeUrl: "https://bridge.example/",
            editModel: "precise-edit-model",
          }),
        writeGeneratedImage: async (filename, data, _fs, cwd) => {
          const path = `${GENERATED_IMAGES_DIRECTORY}/${filename}`;
          writes.push({ path, data, cwd });
          return path;
        },
      },
    );

    expect(JSON.parse(requestBody(calls[0]?.init))).toEqual({
      model: "precise-edit-model",
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
      name: "watercolor-edit.png",
    });
    expect(result.path).toMatch(
      new RegExp(`^${GENERATED_IMAGES_DIRECTORY}/watercolor-edit\\.png$`),
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
      getSettings: () => imagegenSettings(),
      writeGeneratedImage: stubWriter,
    };
    const exec = { agent: { session: { header: { cwd: "/workspace" } } } };

    await generateWithDsh(
      {
        prompt: "edit",
        filename: "five-sources",
        images: ["1.png", "2.png", "3.png", "4.png", "5.png"],
      },
      exec,
      services,
    );
    expect(JSON.parse(requestBody(calls[0]?.init))).toMatchObject({
      model: DEFAULT_EDIT_MODEL,
      images: expect.any(Array),
    });
    expect(JSON.parse(requestBody(calls[0]?.init)).images).toHaveLength(5);
    await generateWithDsh(
      { prompt: "generate", filename: "generated" },
      exec,
      services,
    );
    expect(JSON.parse(requestBody(calls[1]?.init))).toEqual({
      model: DEFAULT_GENERATION_MODEL,
      prompt: "generate",
    });
    await expect(
      generateWithDsh(
        {
          prompt: "edit",
          filename: "six-sources",
          images: ["1.png", "2.png", "3.png", "4.png", "5.png", "6.png"],
        },
        exec,
        services,
      ),
    ).rejects.toThrow("between one and five");
    await expect(
      generateWithDsh(
        { prompt: "   ", filename: "blank-prompt" },
        {},
        services,
      ),
    ).rejects.toThrow("nonblank");
  });

  it("selects configured models from one coherent settings snapshot per operation", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const settings = imagegenSettings({
      bridgeUrl: "https://bridge.example/",
      generationModel: "configured-generation",
      editModel: "configured-edit",
    });
    let settingsReads = 0;
    const services = {
      fs: fakeFileSystem(),
      attachments: fakeAttachments(),
      fetch: bridgeFetch(calls),
      getSettings: () => {
        settingsReads += 1;
        return settings;
      },
      writeGeneratedImage: stubWriter,
    };
    const exec = { agent: { session: { header: { cwd: "/workspace" } } } };

    await generateWithDsh(
      { prompt: "configured generation", filename: "configured-generation" },
      exec,
      services,
    );
    expect(JSON.parse(requestBody(calls[0]?.init))).toEqual({
      model: "configured-generation",
      prompt: "configured generation",
    });
    expect(settingsReads).toBe(1);

    await generateWithDsh(
      {
        prompt: "configured edit",
        filename: "configured-edit",
        images: ["source.png"],
      },
      exec,
      services,
    );
    expect(JSON.parse(requestBody(calls[1]?.init))).toEqual({
      model: "configured-edit",
      prompt: "configured edit",
      images: ["data:image/png;base64,iVBORw0KGgoA"],
    });
    expect(settingsReads).toBe(2);
  });

  it("rejects an invalid stored model before reading workspace sources", async () => {
    const fs = fakeFileSystem();
    await expect(
      generateWithDsh(
        { prompt: "edit", filename: "invalid-model", images: ["source.png"] },
        { agent: { session: { header: { cwd: "/workspace" } } } },
        {
          fs,
          attachments: fakeAttachments(),
          fetch: bridgeFetch([]),
          getSettings: () =>
            imagegenSettings({ editModel: " " }) as ImagegenSettings,
          writeGeneratedImage: stubWriter,
        },
      ),
    ).rejects.toThrow("nonblank image model");
    expect(fs.limits).toEqual([]);
  });

  it("fails source boundary violations without exposing host paths", async () => {
    const baseServices = {
      attachments: fakeAttachments(),
      fetch: bridgeFetch([]),
      getSettings: () => imagegenSettings(),
      writeGeneratedImage: stubWriter,
    };
    const exec = { agent: { session: { header: { cwd: "/workspace" } } } };
    const failures = [
      generateWithDsh(
        {
          prompt: "edit",
          filename: "absolute-source",
          images: ["/etc/passwd"],
        },
        exec,
        {
          ...baseServices,
          fs: fakeFileSystem(),
        },
      ),
      generateWithDsh(
        { prompt: "edit", filename: "outside-source", images: ["link.png"] },
        exec,
        {
          ...baseServices,
          fs: fakeFileSystem({ outside: true }),
        },
      ),
      generateWithDsh(
        { prompt: "edit", filename: "special-source", images: ["pipe.png"] },
        exec,
        {
          ...baseServices,
          fs: fakeFileSystem({ type: "other" }),
        },
      ),
      generateWithDsh(
        { prompt: "edit", filename: "text-source", images: ["source.txt"] },
        exec,
        {
          ...baseServices,
          fs: fakeFileSystem(),
        },
      ),
      generateWithDsh(
        { prompt: "edit", filename: "invalid-source", images: ["source.png"] },
        exec,
        {
          ...baseServices,
          fs: fakeFileSystem({
            bytes: new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]),
          }),
        },
      ),
      generateWithDsh(
        { prompt: "edit", filename: "no-workspace", images: ["source.png"] },
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
      await expect(
        writeGeneratedImage("result.png", png, fs, "/workspace"),
      ).resolves.toBe(`${GENERATED_IMAGES_DIRECTORY}/result.png`);
      await expect(readFile(output)).resolves.toEqual(Buffer.from(png));
      expect(fs.processPaths).toEqual([output]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps existing files unchanged while numbering ordinary and pre-suffixed collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-imagegen-collision-test-"));
    const directory = join(root, GENERATED_IMAGES_DIRECTORY);
    const original = Uint8Array.of(1, 2, 3);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "beach-sunset.png"), original);
      await writeFile(join(directory, "beach-sunset-1.png"), Uint8Array.of(4));

      await expect(
        writeGeneratedImage("beach-sunset", png, localFileSystem(root), root),
      ).resolves.toBe(`${GENERATED_IMAGES_DIRECTORY}/beach-sunset-2.png`);
      await expect(
        readFile(join(directory, "beach-sunset.png")),
      ).resolves.toEqual(Buffer.from(original));

      await expect(
        writeGeneratedImage(
          "beach-sunset-1.png",
          png,
          localFileSystem(root),
          root,
        ),
      ).resolves.toBe(`${GENERATED_IMAGES_DIRECTORY}/beach-sunset-1-1.png`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an existing symlink without following or replacing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-imagegen-symlink-test-"));
    const directory = join(root, GENERATED_IMAGES_DIRECTORY);
    const target = join(root, "protected.png");
    const link = join(directory, "linked.png");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(target, Uint8Array.of(9));
      await symlink(target, link);

      await expect(
        writeGeneratedImage("linked.png", png, localFileSystem(root), root),
      ).resolves.toBe(`${GENERATED_IMAGES_DIRECTORY}/linked-1.png`);
      await expect(readFile(target)).resolves.toEqual(Buffer.from([9]));
      expect((await lstatPath(link)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses exclusive creation for concurrent calls and does not repeat provider generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-imagegen-concurrent-test-"));
    const fs = localFileSystem(root);
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const attachments = fakeAttachments();
    try {
      const exec = { agent: { session: { header: { cwd: root } } } };
      const services = {
        fs,
        attachments,
        fetch: bridgeFetch(calls),
        getSettings: () => imagegenSettings(),
        writeGeneratedImage,
      };
      const results = await Promise.all([
        generateWithDsh(
          { prompt: "first", filename: "concurrent-image" },
          exec,
          services,
        ),
        generateWithDsh(
          { prompt: "second", filename: "concurrent-image" },
          exec,
          services,
        ),
      ]);

      expect(calls).toHaveLength(2);
      expect(new Set(results.map((result) => result.path))).toEqual(
        new Set([
          `${GENERATED_IMAGES_DIRECTORY}/concurrent-image.png`,
          `${GENERATED_IMAGES_DIRECTORY}/concurrent-image-1.png`,
        ]),
      );
      expect(results.map((result) => result.attachment.name)).toEqual(
        expect.arrayContaining([
          "concurrent-image.png",
          "concurrent-image-1.png",
        ]),
      );
      for (const result of results) {
        await expect(readFile(join(root, result.path))).resolves.toEqual(
          Buffer.from(png),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves filesystem cancellation during collision probing", async () => {
    const fs = fakeFileSystem();
    let probes = 0;
    fs.lstat = async () => {
      probes += 1;
      if (probes === 1) return { type: "file" };
      throw Object.assign(new Error("filesystem operation aborted"), {
        code: "FS_ABORTED",
      });
    };
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    await expect(
      generateWithDsh(
        { prompt: "generate", filename: "cancelled-collision" },
        {
          signal: new AbortController().signal,
          agent: { session: { header: { cwd: "/workspace" } } },
        },
        {
          fs,
          attachments: fakeAttachments(),
          fetch: bridgeFetch(calls),
          getSettings: () => imagegenSettings(),
          writeGeneratedImage,
        },
      ),
    ).rejects.toThrow("Image generation was cancelled.");
    expect(probes).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("stops before a read when the dynamic bridge budget is exhausted", async () => {
    const fs = fakeFileSystem();
    await expect(
      generateWithDsh(
        {
          prompt: "x".repeat(MAX_BRIDGE_JSON_BYTES),
          filename: "oversized-prompt",
          images: ["source.png"],
        },
        { agent: { session: { header: { cwd: "/workspace" } } } },
        {
          fs,
          attachments: fakeAttachments(),
          fetch: bridgeFetch([]),
          getSettings: () => imagegenSettings(),
          writeGeneratedImage: stubWriter,
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
          return { get: () => imagegenSettings({ bridgeUrl: "not a URL" }) };
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
          description:
            "Required nonblank English image-generation prompt. Pair it with a descriptive English or Chinese filename.",
        },
        filename: {
          type: "string",
          description:
            "Required descriptive English or Chinese filename, not a path; use .png or omit the extension.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional one to five nonblank paths relative to the active workspace.",
        },
      },
      required: ["prompt", "filename"],
      additionalProperties: false,
    });
    expect(
      validateJsonSchemaValue(tool.parameters, {
        prompt: "generate",
        filename: "generated",
      }),
    ).toEqual([]);
    expect(
      validateJsonSchemaValue(tool.parameters, { images: [] }),
    ).not.toEqual([]);
    expect(
      validateJsonSchemaValue(tool.parameters, {
        prompt: "generate",
        filename: "generated",
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
        value: imagegenSettings({ bridgeUrl: "https://persisted.example/" }),
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: "host" as const,
      }),
      subscribe: () => () => undefined,
      async set(_key: string, value: string) {
        writes.push(value);
      },
    };
    await expect(
      saveSetting(scope, "bridgeUrl", "https://bridge.example/"),
    ).resolves.toBe("https://bridge.example");
    await expect(
      saveSetting(scope, "bridgeUrl", "https://bridge.example/path"),
    ).rejects.toThrow("valid Kepos");
    expect(writes).toEqual(["https://bridge.example"]);
    expect(imagegenSettingsFromSnapshot(scope.getSnapshot()).bridgeUrl).toBe(
      "https://persisted.example",
    );
    expect(decodeSettings({ bridgeUrl: "https://bridge.example/" })).toEqual(
      imagegenSettings({ bridgeUrl: "https://bridge.example" }),
    );
    expect(decodeSettings({ bridgeUrl: "unsafe/path" })).toEqual({
      bridgeUrl: DEFAULT_BRIDGE_URL,
      generationModel: DEFAULT_GENERATION_MODEL,
      editModel: DEFAULT_EDIT_MODEL,
    });
    expect(
      decodeSettings({
        generationModel: "  configured-generation  ",
        editModel: "configured-edit",
      }),
    ).toEqual(
      imagegenSettings({
        generationModel: "configured-generation",
        editModel: "configured-edit",
      }),
    );
    expect(() => decodeSettings({ generationModel: " " })).toThrow(
      "nonblank image model",
    );
    expect(() => normalizeImagegenSettings({ editModel: 42 })).toThrow(
      "nonblank image model",
    );
  });

  it("keeps staged settings across failed or conflicting snapshot reloads", async () => {
    const calls: Array<{ field: string; value: unknown }> = [];
    const scope = {
      getSnapshot: () => ({
        status: "ready" as const,
        value: imagegenSettings({ bridgeUrl: "https://saved.example" }),
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: "host" as const,
      }),
      subscribe: () => () => undefined,
      async set(field: string, value: unknown) {
        calls.push({ field, value });
      },
    };

    await expect(
      saveSetting(scope, "bridgeUrl", "https://bridge.example/"),
    ).resolves.toBe("https://bridge.example");
    await expect(
      saveSetting(scope, "generationModel", "  configured-generation  "),
    ).resolves.toBe("configured-generation");
    await expect(saveSetting(scope, "editModel", " ")).rejects.toThrow(
      "nonblank image model",
    );
    expect(calls).toEqual([
      { field: "bridgeUrl", value: "https://bridge.example" },
      { field: "generationModel", value: "configured-generation" },
    ]);

    const draft = {
      bridgeUrl: {
        value: "https://draft.example",
        saved: "https://saved.example",
      },
      generationModel: {
        value: "staged-generation",
        saved: "saved-generation",
      },
      editModel: { value: "saved-edit", saved: "saved-edit" },
    };
    const saved = imagegenSettings({
      bridgeUrl: "https://other.example",
      generationModel: "other-generation",
      editModel: "other-edit",
    });

    expect(
      syncImagegenSettingsDraft(
        draft,
        imagegenSettings({
          bridgeUrl: "https://saved.example",
          generationModel: "saved-generation",
          editModel: "saved-edit",
        }),
      ),
    ).toEqual(draft);
    expect(syncImagegenSettingsDraft(draft, saved)).toEqual({
      bridgeUrl: {
        value: "https://draft.example",
        saved: "https://other.example",
      },
      generationModel: {
        value: "staged-generation",
        saved: "other-generation",
      },
      editModel: { value: "other-edit", saved: "other-edit" },
    });
    expect(
      syncImagegenSettingsDraft(
        {
          bridgeUrl: {
            value: "https://saved.example",
            saved: "https://saved.example",
          },
          generationModel: {
            value: "saved-generation",
            saved: "saved-generation",
          },
          editModel: { value: "saved-edit", saved: "saved-edit" },
        },
        saved,
      ),
    ).toEqual({
      bridgeUrl: {
        value: "https://other.example",
        saved: "https://other.example",
      },
      generationModel: {
        value: "other-generation",
        saved: "other-generation",
      },
      editModel: { value: "other-edit", saved: "other-edit" },
    });

    const snapshot = {
      status: "ready" as const,
      value: imagegenSettings({
        generationModel: "generation-from-snapshot",
        editModel: "edit-from-snapshot",
      }),
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: "host" as const,
    };
    expect(imagegenSettingsFromSnapshot(snapshot)).toEqual(snapshot.value);
  });
});
