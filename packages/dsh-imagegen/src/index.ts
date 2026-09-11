import {
  DEFAULT_BRIDGE_URL,
  ImagegenError,
  assertNonblankPrompt,
  encodeImageDataUrl,
  isSupportedMediaType,
  normalizeModel,
  normalizeBridgeUrl,
  remainingSourceBytes,
  requestImage,
  type ImageMediaType,
  type RequestImageOptions,
} from "./core.js";
import {
  DEFAULT_EDIT_MODEL,
  DEFAULT_GENERATION_MODEL,
  type ImagegenSettings,
} from "./constants.js";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import z from "@deepseek-ai/schemastery";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const name = "lamplitisles-kepos-imagegen";
export const inject = ["attachments", "fs", "settings", "tools"] as const;
export const SETTINGS_NAMESPACE = "lamplitisles-kepos-imagegen";
export const GENERATED_IMAGES_DIRECTORY = ".dsh/kepos-imagegen";

const PNG_EXTENSION = ".png";
const FILENAME_UNSUPPORTED_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

const modelSetting = (fallback: string) =>
  z
    .transform(z.string().pattern(/\S/u), (value: string) => value.trim(), true)
    .default(fallback);

export const SettingsSchema: z<ImagegenSettings> = z.object({
  bridgeUrl: z.string().default(DEFAULT_BRIDGE_URL).loose(),
  generationModel: modelSetting(DEFAULT_GENERATION_MODEL),
  editModel: modelSetting(DEFAULT_EDIT_MODEL),
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
  lstat(
    path: string,
    options?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<{ type: string } | undefined>;
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
  filename: string;
  images?: readonly string[];
}

export interface DshPluginServices {
  attachments: DshAttachments;
  fs: DshFileSystem;
  getSettings(): ImagegenSettings;
  fetch: typeof globalThis.fetch;
  writeGeneratedImage(
    filename: string,
    data: Uint8Array,
    fs: DshFileSystem,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string>;
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
      get(): {
        bridgeUrl?: unknown;
        generationModel?: unknown;
        editModel?: unknown;
      };
    };
  };
  tools: { register(definition: ToolDefinition): unknown };
};

const toolParameters = {
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
} as const;

export function apply(ctx: DshContext): void {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema);
  const tool = defineTool({
    name: "kepos_image_generate",
    description:
      "Generate a PNG with Kepos. Always provide a descriptive filename and an English prompt; the filename may be English or Chinese and is saved under .dsh/kepos-imagegen/. For an edit, provide one through five PNG, JPEG, GIF, or WebP paths relative to the active workspace; omit images to generate.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "A nonblank English image-generation prompt.",
      },
      filename: {
        type: "string",
        required: true,
        description:
          "A descriptive English or Chinese filename, not a path; use .png or omit the extension.",
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
        getSettings: () => normalizeImagegenSettings(scope.get()),
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
    const { prompt, filename, images } = parseArgs(args);
    const settings = normalizeImagegenSettings(services.getSettings());
    const cwd = workspaceCwd(exec);
    const model =
      images === undefined ? settings.generationModel : settings.editModel;
    const sourceUrls = images
      ? await readDshSources(
          images,
          model,
          prompt,
          exec,
          services.fs,
          services.attachments,
        )
      : undefined;
    const request: RequestImageOptions = {
      fetch: services.fetch,
      model,
      prompt,
      baseUrl: settings.bridgeUrl,
    };
    if (sourceUrls !== undefined) request.images = sourceUrls;
    if (exec.signal !== undefined) request.signal = exec.signal;
    const result = await requestImage(request);
    const path = await services.writeGeneratedImage(
      filename,
      result.data,
      services.fs,
      cwd,
      exec.signal,
    );
    const savedFilename = fileName(path);
    const attachment = asPngAttachment(
      await services.attachments.saveImage({
        data: result.data,
        mediaType: "image/png",
        name: savedFilename,
      }),
    );
    return { attachment, path, message: `Generated image saved to ${path}.` };
  } catch (error) {
    if (isCancellationError(error, exec.signal)) {
      throw new ImagegenError("Image generation was cancelled.");
    }
    throw safeDshError(error);
  }
}

export async function writeGeneratedImage(
  filename: string,
  data: Uint8Array,
  fs: DshFileSystem,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const normalizedFilename = normalizeImageFilename(filename);
  const workspace = await fs.resolve(cwd, { signal });

  for (let suffix = 0; ; suffix += 1) {
    throwIfAborted(signal);
    const savedFilename = filenameWithCollisionSuffix(
      normalizedFilename,
      suffix,
    );
    const path = `${GENERATED_IMAGES_DIRECTORY}/${savedFilename}`;
    const existing = await fs.lstat(path, { cwd }, signal);
    if (existing !== undefined) continue;

    const target = await fs.resolve(path, { cwd, signal });
    if (!fs.contains(workspace, target)) {
      throw new ImagegenError(
        "Generated image output must stay inside the active workspace.",
      );
    }
    const processPath = fs.processPath(target);
    await mkdir(dirname(processPath), { recursive: true });
    throwIfAborted(signal);

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let complete = false;
    try {
      handle = await open(processPath, "wx");
      created = true;
      await handle.writeFile(
        data,
        signal === undefined ? undefined : { signal },
      );
      complete = true;
      await handle.close();
      handle = undefined;
      return path;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        handle = undefined;
      }
      if (created && !complete) await removeIncompleteFile(processPath);
      if (isCollisionError(error)) continue;
      if (isCancellationError(error, signal)) {
        throw new ImagegenError("Image generation was cancelled.");
      }
      throw error;
    }
  }
}

export function normalizeImageFilename(value: unknown): string {
  if (typeof value !== "string") {
    throw new ImagegenError(
      "Provide a descriptive image filename; it is required.",
    );
  }
  if (hasFilenameControlCharacters(value)) {
    throw new ImagegenError(
      "Provide a descriptive image filename without control characters.",
    );
  }
  const filename = value.trim();
  if (filename === "") {
    throw new ImagegenError(
      "Provide a descriptive image filename; it cannot be empty.",
    );
  }
  if (
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    FILENAME_UNSUPPORTED_CHARACTERS.test(filename)
  ) {
    throw new ImagegenError(
      "Use a single descriptive image filename, not a path or traversal name; avoid characters unsupported by cross-platform downloads.",
    );
  }
  if (filename.endsWith(".")) {
    throw new ImagegenError(
      "Use a descriptive image filename that does not end with a period.",
    );
  }

  const hasPngExtension = filename.toLowerCase().endsWith(PNG_EXTENSION);
  const stem = hasPngExtension
    ? filename.slice(0, -PNG_EXTENSION.length)
    : filename;
  if (!hasPngExtension && stem.includes(".")) {
    throw new ImagegenError(
      "Generated images are PNG; use a filename ending in .png or omit the extension.",
    );
  }
  if (stem === "" || stem === "." || stem === "..") {
    throw new ImagegenError(
      "Provide a descriptive image filename with a non-empty name before .png.",
    );
  }
  if (stem.endsWith(" ") || stem.endsWith(".")) {
    throw new ImagegenError(
      "Use a descriptive image filename that does not end in a space or period.",
    );
  }
  if (WINDOWS_DEVICE_NAME.test(stem.split(".", 1)[0] ?? "")) {
    throw new ImagegenError(
      "Choose a different image filename; Windows reserves that device name.",
    );
  }
  return `${stem}${PNG_EXTENSION}`;
}

function hasFilenameControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function filenameWithCollisionSuffix(filename: string, suffix: number): string {
  if (suffix === 0) return filename;
  return `${filename.slice(0, -PNG_EXTENSION.length)}-${suffix}${PNG_EXTENSION}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ImagegenError("Image generation was cancelled.");
  }
}

async function removeIncompleteFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function isCollisionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "EISDIR")
  );
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isCancellationError(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.aborted === true ||
    errorCode(error) === "FS_ABORTED" ||
    isAbortError(error)
  );
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
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
      "Provide an English prompt, a descriptive filename, and optional relative image paths.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "prompt" && key !== "filename" && key !== "images",
    )
  ) {
    throw new ImagegenError(
      "Provide an English prompt, a descriptive filename, and optional relative image paths.",
    );
  }
  assertNonblankPrompt(record.prompt);
  const filename = normalizeImageFilename(record.filename);
  if (record.images === undefined) {
    return { prompt: record.prompt, filename };
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
  return { prompt: record.prompt, filename, images: record.images };
}

async function readDshSources(
  images: readonly string[],
  model: string,
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
    const maxBytes = remainingSourceBytes(model, prompt, sourceUrls, mediaType);
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

export function normalizeImagegenSettings(value: unknown): ImagegenSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImagegenError("The Kepos image settings are invalid.");
  }
  const settings = value as Record<string, unknown>;
  return {
    bridgeUrl: validOrDefault(settings.bridgeUrl),
    generationModel:
      settings.generationModel === undefined
        ? DEFAULT_GENERATION_MODEL
        : normalizeModel(settings.generationModel),
    editModel:
      settings.editModel === undefined
        ? DEFAULT_EDIT_MODEL
        : normalizeModel(settings.editModel),
  };
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
