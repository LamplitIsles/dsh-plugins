import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CORDIS_VERSION,
  DSH_RC_VERSION,
  PUBLIC_PACKAGES,
  SCHEMASTERY_VERSION,
  packageDirectory,
  packRelease,
  checkPackedFiles,
  type PublicPackage,
} from "./release-shared.js";

const root = resolve(import.meta.dirname, "..");

function archiveText(archive: string, path: string): string {
  return execFileSync("tar", ["-xOzf", archive, `package/${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function archivePaths(archive: string): Set<string> {
  return new Set(
    execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((path) => path.replace(/^package\//u, "")),
  );
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkExpandedManifest(
  entry: PublicPackage,
  manifest: Record<string, any>,
): string[] {
  const errors: string[] = [];
  if (manifest.name !== entry.name) errors.push(`${entry.name} packed package name is incorrect.`);
  if (manifest.private === true) errors.push(`${entry.name} packed artifact is private.`);
  const serialized = JSON.stringify(manifest);
  if (serialized.includes("workspace:") || serialized.includes("catalog:")) {
    errors.push(`${entry.name} packed manifest contains an unresolved workspace protocol.`);
  }
  for (const section of ["peerDependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (name.startsWith("@deepseek-ai/dsh-") && version !== DSH_RC_VERSION) {
        errors.push(`${entry.name} has a non-rc.1 ${section} ${name}@${version}.`);
      }
    }
  }
  for (const dependency of ["@deepseek-ai/cordis", "@deepseek-ai/schemastery"]) {
    const expected = dependency === "@deepseek-ai/cordis" ? CORDIS_VERSION : SCHEMASTERY_VERSION;
    if (manifest.peerDependencies?.[dependency] !== expected) {
      errors.push(`${entry.name} lacks ${dependency}@${expected} in peerDependencies.`);
    }
  }
  for (const section of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith("@deepseek-ai/")) {
        errors.push(`${entry.name} ships a Host dependency in ${section}: ${name}.`);
      }
    }
  }
  if (entry.name === "@lamplitisles/dsh-imagegen") {
    if (manifest.dependencies !== undefined || manifest.optionalDependencies !== undefined) {
      errors.push("Imagegen artifact must have no runtime dependencies.");
    }
  }
  const scripts = manifest.scripts ?? {};
  if (["install", "preinstall", "postinstall"].some((name) => name in scripts)) {
    errors.push(`${entry.name} ships an install hook.`);
  }
  return errors;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "dsh-plugins-pack-check-"));
try {
  const results: Array<{ package: string; artifact: string; files: number }> = [];
  const failures: string[] = [];
  for (const entry of PUBLIC_PACKAGES) {
    failures.push(...checkPackedFiles(root, entry));
    if (failures.length) continue;
    const artifact = packRelease(root, entry, temporaryDirectory);
    const paths = archivePaths(artifact);
    for (const required of entry.requiredFiles) {
      requireCondition(paths.has(required), `${entry.name} artifact omits ${required}.`);
    }
    requireCondition(
      [...paths].every((path) => !path.includes("node_modules") && !path.endsWith(".tgz")),
      `${entry.name} artifact contains an unsafe file.`,
    );
    const manifest = JSON.parse(archiveText(artifact, "package.json")) as Record<string, any>;
    failures.push(...checkExpandedManifest(entry, manifest));
    const packagePath = packageDirectory(root, entry);
    const sourceManifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as Record<string, any>;
    requireCondition(manifest.version === sourceManifest.version, `${entry.name} artifact version differs from its source manifest.`);
    results.push({ package: entry.name, artifact, files: paths.size });
  }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(JSON.stringify({ packages: results }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
