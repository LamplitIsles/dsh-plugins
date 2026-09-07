import { describe, expect, it } from "vitest";
import {
  createMatrixToolDefinitions,
  MATRIX_SEND_FILE,
  MATRIX_SEND_MESSAGE,
  MAX_MATRIX_MEDIA_BYTES,
  type KeposSpeechServiceLike,
  type MatrixFileSystemLike
} from "../src/matrix-tools.js";
import type { MatrixClientLike } from "../src/matrix-protocol.js";

const ROOM_ID = "!fixed:example";
const WORKSPACE = "/workspace/session";

type FakeTarget = { displayPath: string; kind: "file" | "directory" | "other"; data?: Uint8Array };

class FakeFs implements MatrixFileSystemLike {
  readonly targets = new Map<string, FakeTarget>();
  readError = false;
  readCalls: Array<{ path: string; maxBytes: number; signal: AbortSignal | undefined }> = [];

  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FakeTarget> {
    if (options?.signal?.aborted) return Promise.reject(new Error("aborted"));
    const base = options?.cwd ?? WORKSPACE;
    const displayPath = path.startsWith("/") ? path : `${base}/${path}`;
    const normalized = displayPath.replace(/\/+/g, "/").replace(/\/\.\//g, "/").replace(/\/[^/]+\/\.\.\//g, "/");
    const target = this.targets.get(normalized) ?? { displayPath: normalized, kind: "other" as const };
    return Promise.resolve(target);
  }

  contains(parent: unknown, child: unknown): boolean {
    const root = (parent as FakeTarget).displayPath.replace(/\/+$/, "");
    const candidate = (child as FakeTarget).displayPath;
    return candidate === root || candidate.startsWith(`${root}/`);
  }

  async stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined> {
    if (signal?.aborted) throw new Error("aborted");
    const value = target as FakeTarget;
    const current = this.targets.get(value.displayPath);
    return current
      ? { type: current.kind, ...(current.data ? { size: current.data.byteLength } : {}) }
      : undefined;
  }

  async readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const value = target as FakeTarget;
    this.readCalls.push({ path: value.displayPath, maxBytes, signal });
    if (signal?.aborted) throw new Error("aborted");
    if (this.readError) throw new Error("secret host path details");
    if (!value.data) throw new Error("missing");
    if (value.data.byteLength > maxBytes) throw new Error("too large");
    return value.data;
  }
}

class FakeClient implements MatrixClientLike {
  readonly sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  readonly uploads: Array<{ data: Uint8Array; options: Record<string, unknown> | undefined }> = [];
  uploadError = false;
  sendError = false;
  readonly replyEvent = {
    getId: () => "$history",
    getRoomId: () => ROOM_ID
  };

  async uploadContent(data: Uint8Array, options?: { name?: string; type?: string; abortController?: AbortController }) {
    this.uploads.push({ data: Uint8Array.from(data), options });
    if (this.uploadError) throw new Error("secret upload provider detail");
    return { content_uri: "mxc://example/media" };
  }

  async sendMessage(roomId: string, content: Record<string, unknown>) {
    if (this.sendError) throw new Error("secret send provider detail");
    this.sent.push({ roomId, content });
  }

  async fetchRoomEvent(roomId: string, eventId: string) {
    if (roomId === ROOM_ID && eventId === "$history") return this.replyEvent;
    throw new Error("not found");
  }

  getRoom() {
    return {
      getJoinedMembers: () => [
        { userId: "@alice:example", name: "Alice", membership: "join" }
      ]
    };
  }
}

function mediaSetup(options: {
  fs?: FakeFs;
  speech?: KeposSpeechServiceLike;
  client?: FakeClient;
  ready?: () => boolean;
} = {}) {
  const fs = options.fs ?? new FakeFs();
  const client = options.client ?? new FakeClient();
  const agent = {
    id: "session-voice",
    session: { header: { cwd: WORKSPACE } },
    ctx: {
      get: (name: string) => name === "fs" ? fs : name === "keposSpeech" ? options.speech : undefined
    }
  };
  const definitions = createMatrixToolDefinitions({
    getClient: () => client,
    roomId: ROOM_ID,
    isReady: options.ready ?? (() => true),
    getAgent: () => agent
  });
  return { fs, client, agent, send: definitions.find((tool) => tool.name === MATRIX_SEND_MESSAGE)!, file: definitions.find((tool) => tool.name === MATRIX_SEND_FILE)! };
}

function exec(signal = new AbortController().signal, agent?: unknown) {
  return { signal, ...(agent ? { agent } : {}) } as never;
}

describe("Matrix media delivery", () => {
  it("keeps ordinary text delivery when voice is omitted or false without Speech", async () => {
    const setup = mediaSetup();
    await setup.send.execute({ body: "omitted" }, exec());
    await setup.send.execute({ body: "ordinary", voice: false }, exec());
    expect(setup.client.sent).toEqual([
      { roomId: ROOM_ID, content: { msgtype: "m.text", body: "omitted" } },
      { roomId: ROOM_ID, content: { msgtype: "m.text", body: "ordinary" } }
    ]);
  });

  it("synthesizes one fixed-room audio event with reply and mention metadata", async () => {
    const requests: Array<{ sessionId: string; text: string; signal?: AbortSignal | undefined }> = [];
    const speech: KeposSpeechServiceLike = {
      synthesize: async (request, signal) => {
        requests.push({ ...request, signal });
        return { mediaType: "audio/mpeg", data: new Uint8Array([1, 2, 3]) };
      }
    };
    const setup = mediaSetup({ speech });
    const { client, send } = setup;
    const controller = new AbortController();
    await expect(send.execute({ body: "voice body", voice: true, replyToEventId: "$history", mentions: ["Alice"] }, exec(controller.signal, setup.agent))).resolves.toEqual({ sent: true });
    expect(requests).toEqual([{ sessionId: "session-voice", text: "voice body", signal: controller.signal }]);
    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0]).toMatchObject({ data: new Uint8Array([1, 2, 3]), options: { name: "语音消息.mp3", type: "audio/mpeg" } });
    expect(client.sent).toEqual([{
      roomId: ROOM_ID,
      content: {
        msgtype: "m.audio",
        body: "语音消息.mp3",
        url: "mxc://example/media",
        info: { mimetype: "audio/mpeg", size: 3 },
        "m.relates_to": { "m.in_reply_to": { event_id: "$history" } },
        "m.mentions": { user_ids: ["@alice:example"] }
      }
    }]);
  });

  it("fails voice calls explicitly when Kepos is absent or returns invalid audio", async () => {
    const absent = mediaSetup();
    await expect(absent.send.execute({ body: "voice", voice: true }, exec())).rejects.toThrow(/voice delivery is unavailable/);
    expect(absent.client.sent).toHaveLength(0);
    const invalid = mediaSetup({ speech: { synthesize: async () => ({ mediaType: "audio/wav", data: new Uint8Array([1]) }) } as never });
    await expect(invalid.send.execute({ body: "voice", voice: true }, exec())).rejects.toThrow(/invalid audio/);
    expect(invalid.client.sent).toHaveLength(0);
  });

  it("sends image media with a description and file media with basename fallback", async () => {
    const fs = new FakeFs();
    fs.targets.set(`${WORKSPACE}/plot.PNG`, { displayPath: `${WORKSPACE}/plot.PNG`, kind: "file", data: new Uint8Array([9, 8]) });
    fs.targets.set(`${WORKSPACE}/report.txt`, { displayPath: `${WORKSPACE}/report.txt`, kind: "file", data: new Uint8Array([7, 6, 5]) });
    const setup = mediaSetup({ fs });
    await setup.file.execute({ path: "plot.PNG", description: "A plot", replyToEventId: "$history" }, exec());
    await setup.file.execute({ path: "report.txt" }, exec());
    expect(setup.client.sent).toEqual([
      {
        roomId: ROOM_ID,
        content: {
          msgtype: "m.image", body: "A plot", url: "mxc://example/media", filename: "plot.PNG",
          info: { mimetype: "image/png", size: 2 },
          "m.relates_to": { "m.in_reply_to": { event_id: "$history" } }
        }
      },
      {
        roomId: ROOM_ID,
        content: {
          msgtype: "m.file", body: "report.txt", url: "mxc://example/media", filename: "report.txt",
          info: { mimetype: "application/octet-stream", size: 3 }
        }
      }
    ]);
    expect(setup.client.uploads.map((upload) => upload.options)).toEqual([
      expect.objectContaining({ name: "plot.PNG", type: "image/png" }),
      expect.objectContaining({ name: "report.txt", type: "application/octet-stream" })
    ]);
  });

  it("rejects outside, missing, non-regular, oversize, unreadable, and malformed paths", async () => {
    const fs = new FakeFs();
    fs.targets.set(`${WORKSPACE}/dir`, { displayPath: `${WORKSPACE}/dir`, kind: "directory" });
    fs.targets.set(`${WORKSPACE}/large.bin`, { displayPath: `${WORKSPACE}/large.bin`, kind: "file", data: new Uint8Array(MAX_MATRIX_MEDIA_BYTES + 1) });
    fs.targets.set(`${WORKSPACE}/secret.bin`, { displayPath: `${WORKSPACE}/secret.bin`, kind: "file", data: new Uint8Array([1]) });
    const setup = mediaSetup({ fs });
    fs.readError = true;
    for (const [path, expected] of [
      ["../outside.txt", /stay inside/],
      ["missing.txt", /regular file/],
      ["dir", /regular file/],
      ["large.bin", /media limit/],
      ["secret.bin", /could not be read/],
      ["https://example/file.txt", /one non-empty path/],
      ["", /one non-empty path/]
    ] as const) {
      await expect(setup.file.execute({ path }, exec())).rejects.toThrow(expected);
    }
    expect(setup.client.sent).toHaveLength(0);
    expect(setup.client.uploads).toHaveLength(0);
  });

  it("maps cancellation, readiness loss, upload failure, and send failure without text fallback", async () => {
    const fs = new FakeFs();
    fs.targets.set(`${WORKSPACE}/report.txt`, { displayPath: `${WORKSPACE}/report.txt`, kind: "file", data: new Uint8Array([1]) });
    const canceled = mediaSetup({ fs });
    const controller = new AbortController();
    controller.abort();
    await expect(canceled.file.execute({ path: "report.txt" }, exec(controller.signal))).rejects.toThrow(/cancelled/);

    let ready = true;
    const readiness = mediaSetup({ fs, ready: () => ready });
    readiness.client.uploadContent = async (data, options) => {
      ready = false;
      readiness.client.uploads.push({ data, options });
      return { content_uri: "mxc://example/media" };
    };
    await expect(readiness.file.execute({ path: "report.txt" }, exec())).rejects.toThrow(/not ready/);
    expect(readiness.client.sent).toHaveLength(0);

    const upload = mediaSetup({ fs });
    upload.client.uploadError = true;
    await expect(upload.file.execute({ path: "report.txt" }, exec())).rejects.toThrow(/upload failed/);
    expect(upload.client.sent).toHaveLength(0);
    const send = mediaSetup({ fs });
    send.client.sendError = true;
    await expect(send.file.execute({ path: "report.txt" }, exec())).rejects.toThrow(/could not be sent/);
    expect(send.client.sent).toHaveLength(0);
  });
});
