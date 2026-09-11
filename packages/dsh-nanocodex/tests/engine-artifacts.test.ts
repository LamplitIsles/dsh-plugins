import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureEngineArtifact } from "../scripts/engine-artifacts.ts";

const directories: string[] = [];
const content = "verified engine fixture";
const artifact = {
  url: "https://example.invalid/engine.tgz",
  sha256: createHash("sha256").update(content).digest("hex"),
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-engine-artifact-"));
  directories.push(directory);
  return { directory, destination: join(directory, "engine.tgz") };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("downloads and verifies an artifact through the anonymous GitHub API contract", async () => {
  const { directory, destination } = await fixture();
  const download = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(content));
  await ensureEngineArtifact(artifact, destination, download);
  expect(await readFile(destination, "utf8")).toBe(content);
  expect(await readdir(directory)).toEqual(["engine.tgz"]);
  expect(download).toHaveBeenCalledWith(artifact.url, {
    headers: {
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: expect.any(AbortSignal),
  });
});

it("reuses a verified cache without network access", async () => {
  const { destination } = await fixture();
  await writeFile(destination, content);
  const download = vi.fn<typeof fetch>();
  await ensureEngineArtifact(artifact, destination, download);
  expect(download).not.toHaveBeenCalled();
  expect(await readFile(destination, "utf8")).toBe(content);
});

it("replaces a stale cache only with the newly verified artifact", async () => {
  const { directory, destination } = await fixture();
  await writeFile(destination, "previous release");
  const download = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(content));
  await ensureEngineArtifact(artifact, destination, download);
  expect(await readFile(destination, "utf8")).toBe(content);
  expect(await readdir(directory)).toEqual(["engine.tgz"]);
});

it("rejects a checksum mismatch without overwriting the cached artifact", async () => {
  const { directory, destination } = await fixture();
  await writeFile(destination, "previous release");
  const download = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("wrong bytes"));
  await expect(
    ensureEngineArtifact(artifact, destination, download),
  ).rejects.toThrow("SHA-256 mismatch");
  expect(await readFile(destination, "utf8")).toBe("previous release");
  expect(await readdir(directory)).toEqual(["engine.tgz"]);
});

it("stops on a failed download without leaving a partial artifact", async () => {
  const { directory, destination } = await fixture();
  const download = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(
    ensureEngineArtifact(artifact, destination, download),
  ).rejects.toThrow("HTTP 503");
  expect(await readdir(directory)).toEqual([]);
});
