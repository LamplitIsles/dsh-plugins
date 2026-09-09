import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_URL,
  MAX_BRIDGE_JSON_BYTES,
  ImagegenError,
  assertBridgePayloadFits,
  decodeImageDataUrl,
  encodeImageDataUrl,
  normalizeBridgeUrl,
  remainingSourceBytes,
  requestImage,
} from "../src/core.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const pngUrl = encodeImageDataUrl(png, "image/png");

function response(imageUrl = pngUrl): Response {
  return new Response(JSON.stringify({ image_url: imageUrl }), { status: 200 });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string")
    throw new Error("test request body was not a string");
  return init.body;
}

describe("Kepos bridge core", () => {
  it("normalizes the default service address", () => {
    expect(normalizeBridgeUrl(DEFAULT_BRIDGE_URL)).toBe(DEFAULT_BRIDGE_URL);
  });

  it("normalizes a bare service origin and rejects unsafe endpoint parts", () => {
    expect(normalizeBridgeUrl("https://bridge.example:8443/")).toBe(
      "https://bridge.example:8443",
    );
    for (const address of [
      "https://user:pass@bridge.example",
      "https://bridge.example/codex/images",
      "https://bridge.example?token=no",
      "https://bridge.example?",
      "https://bridge.example#fragment",
      "file:///tmp/bridge",
    ]) {
      expect(() => normalizeBridgeUrl(address)).toThrow(ImagegenError);
    }
  });

  it("sends the exact unauthenticated generation request and forwards cancellation", async () => {
    const controller = new AbortController();
    let call: { url: string; init: RequestInit | undefined } | undefined;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      call = { url: requestUrl(url), init };
      return response();
    }) as typeof globalThis.fetch;

    await expect(
      requestImage({
        fetch,
        model: "gpt-image-2.5-flare",
        prompt: "a moonlit island",
        baseUrl: "https://bridge.example",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ data: png, mediaType: "image/png" });
    expect(call).toEqual({
      url: "https://bridge.example/codex/images",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2.5-flare",
          prompt: "a moonlit island",
        }),
        credentials: "omit",
        signal: controller.signal,
      },
    });
  });

  it("sends nonempty edit sources unchanged while omitting images for generation", async () => {
    let body = "";
    const source = encodeImageDataUrl(
      new Uint8Array([255, 216, 255, 0]),
      "image/jpeg",
    );
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = requestBody(init);
      return response();
    }) as typeof globalThis.fetch;

    await requestImage({
      fetch,
      model: "gpt-image-2.5-sunburst",
      prompt: "edit it",
      images: [source],
    });
    expect(JSON.parse(body)).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "edit it",
      images: [source],
    });
  });

  it("rejects invalid prompts, source URLs, image counts, and noncanonical data", async () => {
    const neverFetch = (() =>
      Promise.reject(new Error("not called"))) as typeof globalThis.fetch;
    await expect(
      requestImage({ fetch: neverFetch, model: "test-model", prompt: " " }),
    ).rejects.toThrow("nonblank");
    await expect(
      requestImage({
        fetch: neverFetch,
        model: "test-model",
        prompt: "ok",
        images: [],
      }),
    ).rejects.toThrow("between one and five");
    expect(() => decodeImageDataUrl("data:image/png;base64,AA")).toThrow(
      ImagegenError,
    );
    expect(() => decodeImageDataUrl("data:image/png;base64,AAAA===")).toThrow(
      ImagegenError,
    );
    expect(() => decodeImageDataUrl("data:text/plain;base64,QUJD")).toThrow(
      ImagegenError,
    );
  });

  it("does not expose bridge response bodies for HTTP or malformed image failures", async () => {
    const rejected = (async () =>
      new Response("private bridge diagnostic", {
        status: 502,
      })) as typeof globalThis.fetch;
    await expect(
      requestImage({ fetch: rejected, model: "test-model", prompt: "ok" }),
    ).rejects.toThrow("rejected the request");

    const malformed = (async () =>
      response("data:image/jpeg;base64,/9j/")) as typeof globalThis.fetch;
    await expect(
      requestImage({ fetch: malformed, model: "test-model", prompt: "ok" }),
    ).rejects.toThrow("invalid PNG");
  });

  it("enforces the bridge's encoded JSON limit and derives next-source capacity from it", () => {
    const prefix = "data:image/png;base64,";
    const fixed = new TextEncoder().encode(
      JSON.stringify({
        model: "test-model",
        prompt: "x",
        images: [prefix],
      }),
    ).byteLength;
    expect(remainingSourceBytes("test-model", "x", [], "image/png")).toBe(
      Math.floor((MAX_BRIDGE_JSON_BYTES - fixed) / 4) * 3,
    );
    expect(
      remainingSourceBytes(
        "test-model",
        "x",
        [pngUrl, pngUrl, pngUrl, pngUrl, pngUrl],
        "image/png",
      ),
    ).toBe(0);
    expect(() =>
      assertBridgePayloadFits(
        "test-model",
        "x".repeat(MAX_BRIDGE_JSON_BYTES),
        undefined,
      ),
    ).toThrow("too large");
  });

  it("counts escaped and multibyte model bytes before the source read budget", () => {
    const model = `model-"${"界".repeat(32)}`;
    const prefix = "data:image/png;base64,";
    const fixed = new TextEncoder().encode(
      JSON.stringify({ model, prompt: "x", images: [prefix] }),
    ).byteLength;

    expect(remainingSourceBytes(model, "x", [], "image/png")).toBe(
      Math.floor((MAX_BRIDGE_JSON_BYTES - fixed) / 4) * 3,
    );
    expect(() =>
      assertBridgePayloadFits(` ${"界".repeat(MAX_BRIDGE_JSON_BYTES)} `, "x"),
    ).toThrow("too large");
  });

  it("requires an explicit nonblank model without a transport default", async () => {
    const neverFetch = (() =>
      Promise.reject(new Error("not called"))) as typeof globalThis.fetch;

    await expect(
      requestImage({ fetch: neverFetch, model: " ", prompt: "ok" }),
    ).rejects.toThrow("nonblank image model");
    await expect(
      requestImage({ fetch: neverFetch, model: 42 as never, prompt: "ok" }),
    ).rejects.toThrow("nonblank image model");
  });
});
