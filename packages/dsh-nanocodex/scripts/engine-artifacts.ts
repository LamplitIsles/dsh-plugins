import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface EngineArtifact {
  readonly url: string;
  readonly sha256: string;
}

const names = ["nanocodex", "nanocodex-tools"] as const;
type EngineName = (typeof names)[number];

const cacheDirectory = fileURLToPath(
  new URL("../../../.cache/nanocodex/", import.meta.url),
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function ensureEngineArtifact(
  artifact: EngineArtifact,
  destination: string,
  fetchArtifact: typeof fetch = fetch,
): Promise<void> {
  try {
    if (sha256(await readFile(destination)) === artifact.sha256) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const response = await fetchArtifact(artifact.url, {
    headers: {
      Accept: "application/octet-stream",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Nanocodex artifact download failed: HTTP ${response.status}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== artifact.sha256) {
    throw new Error(`Nanocodex artifact SHA-256 mismatch: ${artifact.url}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".download-"));
  try {
    const download = join(temporary, "artifact.tgz");
    await writeFile(download, bytes);
    await rename(download, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareEngineArtifacts(): Promise<
  Record<EngineName, string>
> {
  const release = JSON.parse(
    await readFile(new URL("../engine-release.json", import.meta.url), "utf8"),
  ) as { artifacts: Record<EngineName, EngineArtifact> };
  const archives = {
    nanocodex: join(cacheDirectory, "nanocodex.tgz"),
    "nanocodex-tools": join(cacheDirectory, "nanocodex-tools.tgz"),
  };
  await Promise.all(
    names.map((name) =>
      ensureEngineArtifact(release.artifacts[name], archives[name]),
    ),
  );
  return archives;
}

if (import.meta.main) await prepareEngineArtifacts();
