import {
  DEFAULT_BRIDGE_URL,
  ImagegenError,
  assertNonblankPrompt,
  encodeImageDataUrl,
  isSupportedMediaType,
  normalizeBridgeUrl,
  remainingSourceBytes,
  requestImage,
  type ImageMediaType,
  type RequestImageOptions,
} from "@lamplitisles/imagegen-core";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const name = "lamplitisles-kepos-imagegen";
export const inject = ["attachments", "fs", "settings", "tools"] as const;
export const SETTINGS_NAMESPACE = "lamplitisles-kepos-imagegen";
export const GENERATED_IMAGES_DIRECTORY = ".dsh/kepos-imagegen";

export const SettingsSchema = z.object({
  bridgeUrl: z.string().default(DEFAULT_BRIDGE_URL).loose(),
});

export interface DshTarget {
  readonly targetKey: unknown;
}

export interface DshFileSystem {
  resolve(
    path: string,
    options?: { cwd?: string; signal?: AbortSignal | undefined },
  ): Promise<DshTarget>;
  contains(parent: DshTarget, child: DshTarget): boolean;
  stat(
    target: DshTarget,
    signal?: AbortSignal,
  ): Promise<{ type: string } | undefined>;
  readBytes(
    target: DshTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array>;
  processPath(target: DshTarget): string;
}

export interface DshAttachments {
  validateImage(input: {
    data: Uint8Array;
    mediaType: ImageMediaType;
    name?: string;
  }): Promise<void>;
  saveImage(input: {
    data: Uint8Array;
    mediaType: "image/png";
    name?: string;
  }): Promise<ImageAttachmentRef>;
}

export interface DshExecution {
  readonly signal?: AbortSignal;
  readonly agent?: { session?: { header?: { cwd?: string } } };
}

export interface DshImageArgs {
  prompt: string;
  images?: readonly string[];
}

export interface DshPluginServices {
  attachments: DshAttachments;
  fs: DshFileSystem;
  getBridgeUrl(): string;
  fetch: typeof globalThis.fetch;
  writeGeneratedImage(
    path: string,
    data: Uint8Array,
    fs: DshFileSystem,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface DshToolResult {
  attachment: DshPngAttachment;
  path: string;
  message: string;
}

type DshPngAttachment = Omit<ImageAttachmentRef, "mediaType"> & {
  mediaType: "image/png";
};

type DshContext = {
  attachments: DshAttachments;
  fs: DshFileSystem;
  settings: {
    register(
      namespace: unknown,
      schema: unknown,
    ): {
      get(): { bridgeUrl?: unknown };
    };
  };
  tools: { register(definition: ToolDefinition): unknown };
};

const toolParameters = {
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
} as const;

export function apply(ctx: DshContext): void {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema);
  const tool = defineTool({
    name: "kepos_image_generate",
    description:
      "Generate a PNG with Kepos. For an edit, provide one through five PNG, JPEG, GIF, or WebP paths relative to the active workspace; omit images to generate.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "A nonblank image-generation prompt.",
      },
      images: {
        type: "array",
        items: { type: "string" },
        description: "One through five paths relative to the active workspace.",
      },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          attachment: {
            type: "object",
            properties: {
              attachmentId: { type: "string", required: true },
              mediaType: { type: "string", const: "image/png", required: true },
              bytes: { type: "integer", required: true },
              width: { type: "integer", required: true },
              height: { type: "integer", required: true },
              name: { type: "string" },
            },
            additionalProperties: false,
            required: true,
          },
          path: { type: "string", required: true },
          message: { type: "string", required: true },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        return [
          { type: "image", attachment: value.attachment as ImageAttachmentRef },
          { type: "text", text: value.message },
        ];
      },
    },
    async execute(args, exec) {
      return generateWithDsh(args, exec, {
        attachments: ctx.attachments,
        fs: ctx.fs,
        getBridgeUrl: () => validOrDefault(scope.get().bridgeUrl),
        fetch: globalThis.fetch,
        writeGeneratedImage,
      });
    },
  });
  ctx.tools.register({ ...tool, parameters: toolParameters });
}

export async function generateWithDsh(
  args: unknown,
  exec: DshExecution,
  services: DshPluginServices,
): Promise<DshToolResult> {
  try {
    const { prompt, images } = parseArgs(args);
    const cwd = workspaceCwd(exec);
    const sourceUrls = images
      ? await readDshSources(
          images,
          prompt,
          exec,
          services.fs,
          services.attachments,
        )
      : undefined;
    const request: RequestImageOptions = {
      fetch: services.fetch,
      prompt,
      baseUrl: validOrDefault(services.getBridgeUrl()),
    };
    if (sourceUrls !== undefined) request.images = sourceUrls;
    if (exec.signal !== undefined) request.signal = exec.signal;
    const result = await requestImage(request);
    const path = generatedImagePath();
    await services.writeGeneratedImage(
      path,
      result.data,
      services.fs,
      cwd,
      exec.signal,
    );
    const attachment = asPngAttachment(
      await services.attachments.saveImage({
        data: result.data,
        mediaType: "image/png",
        name: "kepos-image.png",
      }),
    );
    return { attachment, path, message: `Generated image saved to ${path}.` };
  } catch (error) {
    throw safeDshError(error);
  }
}

function generatedImagePath(): string {
  return `${GENERATED_IMAGES_DIRECTORY}/${randomUUID()}.png`;
}

export async function writeGeneratedImage(
  path: string,
  data: Uint8Array,
  fs: DshFileSystem,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  const target = await fs.resolve(path, { cwd, signal });
  const processPath = fs.processPath(target);
  await mkdir(dirname(processPath), { recursive: true });
  await writeFile(processPath, data, { signal });
}

function workspaceCwd(exec: DshExecution): string {
  const cwd = exec.agent?.session?.header?.cwd;
  if (!cwd) {
    throw new ImagegenError(
      "Image generation requires an active workspace to save the result.",
    );
  }
  return cwd;
}

function asPngAttachment(attachment: ImageAttachmentRef): DshPngAttachment {
  if (attachment.mediaType !== "image/png") {
    throw new ImagegenError("Unable to save the generated image.");
  }
  return attachment as DshPngAttachment;
}

function parseArgs(value: unknown): DshImageArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImagegenError(
      "Provide a nonblank prompt and optional relative image paths.",
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "prompt" && key !== "images")) {
    throw new ImagegenError(
      "Provide a nonblank prompt and optional relative image paths.",
    );
  }
  assertNonblankPrompt(record.prompt);
  if (record.images === undefined) {
    return { prompt: record.prompt };
  }
  if (
    !Array.isArray(record.images) ||
    record.images.length === 0 ||
    record.images.length > 5 ||
    record.images.some(
      (image) => typeof image !== "string" || image.trim() === "",
    )
  ) {
    throw new ImagegenError(
      "Provide between one and five relative source image paths.",
    );
  }
  return { prompt: record.prompt, images: record.images };
}

async function readDshSources(
  images: readonly string[],
  prompt: string,
  exec: DshExecution,
  fs: DshFileSystem,
  attachments: DshAttachments,
): Promise<string[]> {
  const cwd = exec.agent?.session?.header?.cwd;
  if (!cwd) {
    throw new ImagegenError("Image edits require an active workspace.");
  }
  const workspace = await fs.resolve(cwd, { signal: exec.signal });
  const sourceUrls: string[] = [];
  for (const image of images) {
    if (isAbsolutePath(image)) {
      throw new ImagegenError(
        "Source image paths must be relative to the active workspace.",
      );
    }
    const mediaType = mediaTypeForPath(image);
    const target = await fs.resolve(image, { cwd, signal: exec.signal });
    if (!fs.contains(workspace, target)) {
      throw new ImagegenError(
        "Source image paths must stay inside the active workspace.",
      );
    }
    const stat = await fs.stat(target, exec.signal);
    if (!stat || stat.type !== "file") {
      throw new ImagegenError("Each source image must be a regular file.");
    }
    const maxBytes = remainingSourceBytes(prompt, sourceUrls, mediaType);
    if (maxBytes === 0) {
      throw new ImagegenError(
        "The image request is too large for the Kepos bridge.",
      );
    }
    const data = await fs.readBytes(target, exec.signal, maxBytes);
    if (
      data.byteLength === 0 ||
      data.byteLength > maxBytes ||
      !hasImageSignature(data, mediaType)
    ) {
      throw new ImagegenError(
        "A source image is invalid or too large for the Kepos bridge.",
      );
    }
    await attachments.validateImage({ data, mediaType, name: fileName(image) });
    sourceUrls.push(encodeImageDataUrl(data, mediaType));
  }
  return sourceUrls;
}

export function validOrDefault(value: unknown): string {
  try {
    return normalizeBridgeUrl(
      typeof value === "string" ? value : DEFAULT_BRIDGE_URL,
    );
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

function mediaTypeForPath(path: string): ImageMediaType {
  const extension = path.toLowerCase().split(".").pop();
  const mediaType =
    extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "gif"
          ? "image/gif"
          : extension === "webp"
            ? "image/webp"
            : undefined;
  if (!isSupportedMediaType(mediaType)) {
    throw new ImagegenError(
      "Source images must be PNG, JPEG, GIF, or WebP files.",
    );
  }
  return mediaType;
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(path);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "source-image";
}

function hasImageSignature(
  data: Uint8Array,
  mediaType: ImageMediaType,
): boolean {
  if (mediaType === "image/png") {
    return (
      data.length >= 8 &&
      data[0] === 137 &&
      data[1] === 80 &&
      data[2] === 78 &&
      data[3] === 71 &&
      data[4] === 13 &&
      data[5] === 10 &&
      data[6] === 26 &&
      data[7] === 10
    );
  }
  if (mediaType === "image/jpeg") {
    return (
      data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
    );
  }
  if (mediaType === "image/gif") {
    const header = new TextDecoder().decode(data.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  return (
    data.length >= 12 &&
    new TextDecoder().decode(data.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(data.slice(8, 12)) === "WEBP"
  );
}

function safeDshError(error: unknown): ImagegenError {
  if (error instanceof ImagegenError) {
    return error;
  }
  return new ImagegenError(
    "Unable to process the image request in the active workspace.",
  );
}
