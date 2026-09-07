import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPOSITORY_URL =
  "https://github.com/LamplitIsles/dsh-plugins.git" as const;
export const DSH_RC_VERSION = "0.1.2-rc.1" as const;
export const CORDIS_VERSION = "4.0.2" as const;
export const SCHEMASTERY_VERSION = "3.18.2" as const;

export const PUBLIC_PACKAGES = [
  {
    directory: "dsh-companion",
    name: "@lamplitisles/dsh-companion",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/client.js",
      "dist/client.d.ts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
    ],
  },
  {
    directory: "dsh-mail",
    name: "@lamplitisles/dsh-mail",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/client.js",
      "dist/client.d.cts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
      "CONTEXT.md",
    ],
  },
  {
    directory: "dsh-matrix",
    name: "@lamplitisles/dsh-matrix",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/client.js",
      "dist/client.d.cts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
  },
  {
    directory: "dsh-speech",
    name: "@lamplitisles/dsh-speech",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/client.js",
      "dist/client.d.cts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ],
  },
  {
    directory: "dsh-hindsight",
    name: "@lamplitisles/dsh-hindsight",
    requiredFiles: [
      "dist/dsh.js",
      "dist/dsh.d.ts",
      "dist/client.js",
      "dist/client.d.cts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
    ],
  },
  {
    directory: "dsh-imagegen",
    name: "@lamplitisles/dsh-imagegen",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/client.js",
      "dist/client.d.cts",
      "cordis.patch.yml",
      "README.md",
      "LICENSE",
    ],
  },
] as const;

export type PublicPackage = (typeof PUBLIC_PACKAGES)[number];

const numericIdentifier = "(?:0|[1-9]\\d*)";
const nonNumericIdentifier = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
const buildIdentifier = "[0-9A-Za-z-]+";
const tagPattern = new RegExp(
  `^v${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
    `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
    `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
  "u",
);

export function versionFromTag(tag: string): string {
  if (!tagPattern.test(tag)) {
    throw new Error(
      "Release tags must use v<semver>, for example v0.1.0 or v0.1.0-beta.1.",
    );
  }
  return tag.slice(1);
}

export function npmDistTag(tag: string): "latest" | "beta" {
  const version = versionFromTag(tag);
  return version.split("+", 1)[0].includes("-") ? "beta" : "latest";
}

export function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

export type PackedFile = { path?: string };
export type PackedPackage = {
  name?: string;
  version?: string;
  filename?: string;
  files?: PackedFile[];
};
export type PackedManifest =
  | PackedPackage
  | PackedPackage[]
  | Record<string, PackedPackage>;

export function packedManifest(
  packed: PackedManifest,
): PackedPackage | undefined {
  if (Array.isArray(packed)) return packed[0];
  if ("files" in packed || "filename" in packed) return packed;
  return Object.values(packed)[0];
}

export function packedFilePaths(packed: PackedManifest): Set<string> {
  return new Set(
    (packedManifest(packed)?.files ?? []).flatMap((file) =>
      file.path === undefined ? [] : [file.path],
    ),
  );
}

export function packageFor(value: string): PublicPackage | undefined {
  const normalized = value.startsWith("./packages/")
    ? value.slice("./packages/".length)
    : value;
  return PUBLIC_PACKAGES.find(
    (entry) => entry.name === value || entry.directory === normalized,
  );
}

export function packageDirectory(root: string, entry: PublicPackage): string {
  return join(root, "packages", entry.directory);
}

function parsePnpmPackOutput(output: string): PackedManifest {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed) as PackedManifest;
  } catch {
    throw new Error(`pnpm pack returned invalid JSON: ${trimmed.slice(0, 200)}`);
  }
}

export function pnpmPack(
  directory: string,
  options: { destination?: string; dryRun?: boolean } = {},
): PackedManifest {
  const args = ["pack", "--json"];
  if (options.dryRun) args.push("--dry-run");
  if (options.destination) {
    args.push("--pack-destination", resolve(options.destination));
  }
  return parsePnpmPackOutput(
    execFileSync("pnpm", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

export function packedArtifactPath(
  packed: PackedManifest,
  destination: string,
): string {
  const filename = packedManifest(packed)?.filename;
  if (!filename) throw new Error("pnpm pack did not return a tarball name.");
  return resolve(filename.startsWith("/") ? filename : join(destination, filename));
}

export function checkReleaseManifest(
  root: string,
  entry: PublicPackage,
  tag: string,
): string[] {
  const errors: string[] = [];
  let version: string;
  try {
    version = versionFromTag(tag);
  } catch (error) {
    return [error instanceof Error ? error.message : "Invalid release tag."];
  }

  let manifest: Record<string, any>;
  try {
    manifest = readJson(join(packageDirectory(root, entry), "package.json"));
  } catch {
    return [`${entry.name} package.json could not be read.`];
  }

  if (manifest.name !== entry.name) errors.push(`package name must be ${entry.name}.`);
  if (manifest.version !== version) errors.push(`${entry.name} version does not match ${tag}.`);
  if (manifest.private === true) errors.push(`${entry.name} must be publishable.`);
  if (manifest.repository?.type !== "git" || manifest.repository?.url !== REPOSITORY_URL ||
      manifest.repository?.directory !== `packages/${entry.directory}`) {
    errors.push(`${entry.name} has the wrong repository metadata.`);
  }
  if (
    manifest.publishConfig?.registry !== "https://registry.npmjs.org" ||
    manifest.publishConfig?.access !== "public"
  ) {
    errors.push(`${entry.name} must publish publicly to npm.`);
  }
  if (JSON.stringify(manifest).includes("workspace:")) {
    errors.push(`${entry.name} leaks a workspace protocol.`);
  }
  const scripts = manifest.scripts ?? {};
  if (["install", "preinstall", "postinstall"].some((name) => name in scripts)) {
    errors.push(`${entry.name} must not have install hooks.`);
  }
  return errors;
}

export function checkPackedFiles(
  root: string,
  entry: PublicPackage,
): string[] {
  const directory = packageDirectory(root, entry);
  const errors: string[] = [];
  for (const required of entry.requiredFiles) {
    if (!existsSync(join(directory, required))) {
      errors.push(`${entry.name} is missing built file ${required}.`);
    }
  }
  if (errors.length) return errors;

  let packed: PackedManifest;
  try {
    packed = pnpmPack(directory, { dryRun: true });
  } catch (error) {
    return [`${entry.name} could not produce a pnpm packed manifest: ${String(error)}`];
  }
  const packageManifest = readJson(join(directory, "package.json"));
  const packedEntry = packedManifest(packed);
  if (packedEntry?.name !== entry.name) errors.push(`${entry.name} packed manifest has the wrong name.`);
  if (packedEntry?.version !== packageManifest.version) errors.push(`${entry.name} packed manifest has the wrong version.`);
  const files = packedFilePaths(packed);
  for (const required of entry.requiredFiles) {
    if (!files.has(required)) errors.push(`${entry.name} packed manifest omits ${required}.`);
  }
  if ([...files].some((file) => file.includes("node_modules") || file.endsWith(".tgz"))) {
    errors.push(`${entry.name} packed manifest contains an unsafe build artifact.`);
  }
  return errors;
}

export function packRelease(
  root: string,
  entry: PublicPackage,
  destination: string,
): string {
  const directory = packageDirectory(root, entry);
  const packed = pnpmPack(directory, { destination });
  const metadata = packedManifest(packed);
  if (metadata?.name !== entry.name) {
    throw new Error(`${entry.name} did not produce the expected release tarball.`);
  }
  return packedArtifactPath(packed, destination);
}
