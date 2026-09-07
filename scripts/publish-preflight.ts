import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkReleaseManifest, npmDistTag, versionFromTag } from "./release-shared.js";
import { parseReleaseRequest } from "./release.js";

export function checkRegistryVersion(version: string, registry: {
  versions?: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}): void {
  versionFromTag(`v${version}`);
  if (Object.hasOwn(registry.versions ?? {}, version)) {
    throw new Error(`Version ${version} is already published; choose a new version.`);
  }
  const latest = registry["dist-tags"]?.latest;
  if (npmDistTag(`v${version}`) === "latest" && latest) {
    versionFromTag(`v${latest}`);
    const candidate = version.split("+")[0]!.split(".").map(BigInt);
    const current = latest.split(/[+-]/)[0]!.split(".").map(BigInt);
    const differing = candidate.findIndex((value, index) => value !== current[index]);
    const sameStable = differing < 0 && npmDistTag(`v${latest}`) === "latest";
    if (sameStable || (differing >= 0 && candidate[differing]! < current[differing]!)) {
      throw new Error(`Stable version ${version} must be newer than npm latest ${latest}.`);
    }
  }
}

async function main(): Promise<void> {
  const request = parseReleaseRequest(["check", ...process.argv.slice(2)]);
  const errors = checkReleaseManifest(resolve(import.meta.dirname, ".."), request.entry, request.tag);
  if (errors.length) throw new Error(errors.join("\n"));
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(request.entry.name)}`,
    { signal: AbortSignal.timeout(30_000), cache: "no-store" },
  );
  if (response.status !== 404 && !response.ok) {
    throw new Error(`npm registry lookup failed: HTTP ${response.status}`);
  }
  const version = versionFromTag(request.tag);
  checkRegistryVersion(version, response.status === 404 ? {} : await response.json());
  const channel = npmDistTag(request.tag);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `channel=${channel}\n`);
  }
  console.log(`${request.entry.name}@${version}: unpublished, channel ${channel}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
