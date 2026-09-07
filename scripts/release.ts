import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_PACKAGES,
  checkPackedFiles,
  checkReleaseManifest,
  packageFor,
  packageDirectory,
  packRelease,
  npmDistTag,
  versionFromTag,
  type PublicPackage,
} from "./release-shared.js";

const root = resolve(import.meta.dirname, "..");

export type ReleaseRequest = {
  command: "check" | "prepare";
  entry: PublicPackage;
  tag: string;
  destination?: string;
};

export function parseReleaseRequest(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseRequest {
  const normalized = args[0] === "--" ? args.slice(1) : [...args];
  if (normalized[1] === "--") normalized.splice(1, 1);
  const [command, selector, argumentTag, requestedDestination] = normalized;
  if (command !== "check" && command !== "prepare") {
    throw new Error("Usage: release.ts <check|prepare> <package-name|directory> <v<semver>> [destination].");
  }
  const entry = selector === undefined ? undefined : packageFor(selector);
  if (!entry) {
    throw new Error(`Select exactly one public package: ${PUBLIC_PACKAGES.map(({ name }) => name).join(", ")}.`);
  }
  const tag = argumentTag ?? environment.RELEASE_TAG;
  if (!tag) throw new Error("A release tag is required, for example v0.1.0-beta.1.");
  versionFromTag(tag);
  return {
    command,
    entry,
    tag,
    destination: requestedDestination ?? environment.RELEASE_ARTIFACT_DIR,
  };
}

function runHostGate(entry: PublicPackage): void {
  execFileSync("pnpm", ["exec", "tsx", "scripts/artifact-smoke.ts", entry.name], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const request = parseReleaseRequest(process.argv.slice(2));
  const errors = [
    ...checkReleaseManifest(root, request.entry, request.tag),
    ...checkPackedFiles(root, request.entry),
  ];
  if (errors.length) throw new Error(errors.join("\n"));

  runHostGate(request.entry);
  if (request.command === "prepare") {
    const destination = resolve(
      request.destination ?? `.release-artifacts/${request.entry.directory}`,
    );
    await mkdir(destination, { recursive: true });
    const artifact = packRelease(root, request.entry, destination);
    console.log(JSON.stringify({ package: request.entry.name, tag: request.tag, channel: npmDistTag(request.tag), artifact }, null, 2));
  } else {
    console.log(`${request.entry.name} release check passed for ${request.tag} (${npmDistTag(request.tag)}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
