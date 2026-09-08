import { describe, expect, it } from "vitest";
import {
  imageFileFromCapturedMedia,
  imageFilesFromClipboard,
  imageIntakeError,
} from "../src/client/image-drafts.js";

const limits = {
  maxImageBytes: 10,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 15,
  maxImagePixels: 1_000,
  maxImageDimension: 100,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
} as const;

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

describe("Companion image drafts", () => {
  it("refuses invalid batches and accepts a supported batch within the limits", () => {
    expect(
      imageIntakeError([], [file("one.png", "image/png", 8)], limits),
    ).toBeUndefined();
    expect(
      imageIntakeError(
        [],
        [file("one.png", "image/png", 8), file("two.png", "image/png", 8)],
        limits,
      ),
    ).toBeDefined();
    expect(
      imageIntakeError([], [file("one.heic", "image/heic", 1)], limits),
    ).toBeDefined();
    expect(
      imageIntakeError(
        [{ file: file("old.png", "image/png", 1) } as never],
        [file("one.png", "image/png", 1), file("two.png", "image/png", 1)],
        limits,
      ),
    ).toEqual({
      key: "image.countLimit",
      params: { count: limits.maxImagesPerMessage },
    });
  });

  it("keeps clipboard image order and ignores non-image clipboard files", () => {
    const first = file("first.png", "image/png", 1);
    const second = file("second.jpeg", "image/jpeg", 1);
    const nonImage = file("notes.txt", "text/plain", 1);
    const clipboard = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => first },
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/jpeg", getAsFile: () => second },
      ],
      files: [first, nonImage, second],
    } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(clipboard)).toEqual([first, second]);
  });

  it("converts a captured media URL into an image File for the existing intake", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const file = await imageFileFromCapturedMedia(
      { webPath: "https://camera.test/capture", metadata: { format: "jpg" } },
      async () =>
        new Response(new Blob([bytes], { type: "application/octet-stream" }), {
          status: 200,
        }),
    );

    expect(file).toMatchObject({
      name: "camera-photo.jpeg",
      type: "image/jpeg",
      size: bytes.byteLength,
    });
    expect(imageIntakeError([], [file], limits)).toBeUndefined();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("rejects captured results without an image URL or supported media type", async () => {
    await expect(imageFileFromCapturedMedia({})).rejects.toThrow(
      "camera-media-missing-url",
    );
    await expect(
      imageFileFromCapturedMedia(
        { webPath: "https://camera.test/capture" },
        async () =>
          new Response(new Blob(["not-an-image"], { type: "image/heic" }), {
            status: 200,
          }),
      ),
    ).rejects.toThrow("camera-media-unsupported-type");
  });
});
