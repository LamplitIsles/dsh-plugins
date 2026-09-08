import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_RC_VERSION,
  PUBLIC_PACKAGES,
  checkReleaseManifest,
  npmDistTag,
  packageFor,
  versionFromTag,
} from "../scripts/release-shared.js";
import { parseReleaseRequest } from "../scripts/release.js";
import { checkRegistryVersion } from "../scripts/publish-preflight.js";
import { releaseChanges } from "../scripts/release-changes.js";

const fixtures: string[] = [];

async function fixture(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugins-release-"));
  fixtures.push(root);
  const entry = PUBLIC_PACKAGES[0];
  const directory = join(root, "packages", entry.directory);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: entry.name,
      version: "0.1.0",
      repository: {
        type: "git",
        url: "https://github.com/LamplitIsles/dsh-plugins.git",
        directory: "packages/dsh-companion",
      },
      publishConfig: {
        registry: "https://registry.npmjs.org",
        access: "public",
      },
      ...overrides,
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("automatic releases", () => {
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  async function repository() {
    const root = await fixture();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.name", "Release test");
    git(root, "config", "user.email", "release@example.invalid");
    commit(root);
    return root;
  }
  function commit(root: string) {
    git(root, "add", ".");
    git(
      root,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    );
    return git(root, "rev-parse", "HEAD");
  }
  async function manifest(
    root: string,
    directory: string,
    version: string,
    extra = {},
  ) {
    await mkdir(join(root, "packages", directory), { recursive: true });
    await writeFile(
      join(root, "packages", directory, "package.json"),
      JSON.stringify({
        name: `@lamplitisles/${directory}`,
        version,
        ...extra,
      }),
    );
  }

  it("does not release ordinary code or metadata changes", async () => {
    const root = await repository();
    const before = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "code.ts"), "export const value = 1;\n");
    await manifest(root, "dsh-companion", "0.1.0", { description: "updated" });
    expect(releaseChanges(root, before, commit(root))).toEqual([]);
  });

  it("selects only bumped packages across a batched push using the exact after commit", async () => {
    const root = await repository();
    await manifest(root, "dsh-mail", "0.1.0");
    const before = commit(root);
    await manifest(root, "dsh-companion", "0.3.0");
    commit(root);
    await manifest(root, "dsh-mail", "0.2.0-beta.1");
    const after = commit(root);
    await manifest(root, "dsh-mail", "9.0.0");
    expect(releaseChanges(root, before, after)).toEqual([
      { package: "dsh-companion", version: "0.3.0" },
      { package: "dsh-mail", version: "0.2.0-beta.1" },
    ]);
  });

  it("does not turn new manifests or initial pushes into bulk releases", async () => {
    const root = await repository();
    const before = git(root, "rev-parse", "HEAD");
    await manifest(root, "dsh-mail", "0.2.0");
    const after = commit(root);
    expect(releaseChanges(root, before, after)).toEqual([]);
    expect(() => releaseChanges(root, "0".repeat(40), after)).toThrow(
      "existing commit SHAs",
    );
    expect(() => releaseChanges(root, "main", after)).toThrow(
      "existing commit SHAs",
    );
    expect(() => releaseChanges(root, after, before)).toThrow("Command failed");
  });

  it("rejects invalid versions and changed package identities", async () => {
    const root = await repository();
    const before = git(root, "rev-parse", "HEAD");
    await manifest(root, "dsh-companion", "invalid");
    expect(() => releaseChanges(root, before, commit(root))).toThrow(
      "v<semver>",
    );
    await manifest(root, "dsh-companion", "0.3.0", { name: "unexpected" });
    expect(() => releaseChanges(root, before, commit(root))).toThrow(
      "Unexpected package identity",
    );
  });
});

describe("workspace release selection", () => {
  it("rejects published versions and stable latest regressions", () => {
    expect(() =>
      checkRegistryVersion("0.2.3", { versions: { "0.2.3": {} } }),
    ).toThrow("already published");
    expect(() =>
      checkRegistryVersion("0.1.0", { "dist-tags": { latest: "0.2.3" } }),
    ).toThrow("must be newer");
    expect(() =>
      checkRegistryVersion("0.2.3+build", { "dist-tags": { latest: "0.2.3" } }),
    ).toThrow("must be newer");
    expect(() =>
      checkRegistryVersion("0.1.0+build-one", {
        "dist-tags": { latest: "0.2.3" },
      }),
    ).toThrow("must be newer");
    expect(() =>
      checkRegistryVersion("0.2.4", {
        "dist-tags": { latest: "0.2.4-beta.0" },
      }),
    ).not.toThrow();
    expect(() =>
      checkRegistryVersion("0.2.4", { "dist-tags": { latest: "0.2.3" } }),
    ).not.toThrow();
    expect(() =>
      checkRegistryVersion("0.3.0-beta.0", {
        "dist-tags": { latest: "0.2.3" },
      }),
    ).not.toThrow();
    expect(() => checkRegistryVersion("0.1.0-beta.0", {})).not.toThrow();
  });

  it("rejects a wrong monorepo package directory", async () => {
    const root = await fixture({
      repository: {
        type: "git",
        url: "https://github.com/LamplitIsles/dsh-plugins.git",
        directory: "packages/dsh-mail",
      },
    });
    expect(checkReleaseManifest(root, PUBLIC_PACKAGES[0], "v0.1.0")).toContain(
      "@lamplitisles/dsh-companion has the wrong repository metadata.",
    );
  });
  it("selects only public package identities", () => {
    expect(packageFor("@lamplitisles/dsh-mail")?.directory).toBe("dsh-mail");
    expect(packageFor("dsh-mail")?.name).toBe("@lamplitisles/dsh-mail");
    expect(packageFor("@lamplitisles/dsh-tabletop")?.directory).toBe(
      "dsh-tabletop",
    );
    expect(PUBLIC_PACKAGES).toHaveLength(8);
  });

  it("rejects missing and malformed release input", () => {
    expect(() => parseReleaseRequest(["check"])).toThrow(
      "Select exactly one public package",
    );
    expect(() => parseReleaseRequest(["check", "dsh-mail", "0.1.0"])).toThrow(
      "Release tags must use",
    );
    expect(() =>
      parseReleaseRequest(["publish", "dsh-mail", "v0.1.0"]),
    ).toThrow("Usage");
  });

  it("accepts the argument separator emitted by pnpm run", () => {
    expect(
      parseReleaseRequest(["check", "--", "dsh-mail", "v0.1.0"]).entry.name,
    ).toBe("@lamplitisles/dsh-mail");
  });

  it("keeps independent package versions and the npm channel mapping", async () => {
    const root = await fixture();
    expect(checkReleaseManifest(root, PUBLIC_PACKAGES[0], "v0.1.0")).toEqual(
      [],
    );
    expect(npmDistTag("v0.1.0")).toBe("latest");
    expect(npmDistTag("v0.1.0-beta.1")).toBe("beta");
    expect(versionFromTag("v1.2.3-alpha01+build.1")).toBe(
      "1.2.3-alpha01+build.1",
    );
    expect(DSH_RC_VERSION).toBe("0.1.2-rc.1");
  });

  it("reports wrong public repository metadata before any host gate", async () => {
    const root = await fixture({
      repository: { type: "git", url: "https://example.invalid/old.git" },
    });
    expect(checkReleaseManifest(root, PUBLIC_PACKAGES[0], "v0.1.0")).toContain(
      "@lamplitisles/dsh-companion has the wrong repository metadata.",
    );
  });
});
