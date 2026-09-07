import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLIC_PACKAGES, versionFromTag } from "./release-shared.js";

export function releaseChanges(root: string, before: string, after: string) {
  for (const commit of [before, after]) {
    if (!/^[a-f0-9]{40}$/u.test(commit) || /^0+$/u.test(commit)) {
      throw new Error("Release detection requires two existing commit SHAs.");
    }
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("merge-base", "--is-ancestor", before, after);
  const files = new Set(git("diff", "--name-only", before, after, "--", "packages").split("\n"));
  return PUBLIC_PACKAGES.flatMap((entry) => {
    const path = `packages/${entry.directory}/package.json`;
    if (!files.has(path)) return [];
    // A newly added package has no release baseline: bootstrap it explicitly.
    if (!git("ls-tree", before, "--", path)) return [];
    const oldManifest = JSON.parse(git("show", `${before}:${path}`));
    const manifest = JSON.parse(git("show", `${after}:${path}`));
    if (manifest.version === oldManifest.version) return [];
    if (manifest.name !== entry.name) throw new Error(`Unexpected package identity at ${path}.`);
    const version = versionFromTag(`v${manifest.version}`);
    return [{ package: entry.directory, version }];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [before, after] = process.argv.slice(2);
  const releases = releaseChanges(resolve(import.meta.dirname, ".."), before ?? "", after ?? "");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: releases })}\nhas-releases=${releases.length > 0}\n`);
  }
  console.log(JSON.stringify(releases));
}
