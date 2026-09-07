import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const fixtures: string[] = [];

async function fixture(overrides: Record<string, unknown> = {}): Promise<string> {
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
      repository: { type: "git", url: "http://forgejo.localhost:17480/LamplitIsles/dsh-plugins.git" },
      publishConfig: { registry: "https://registry.npmjs.org", access: "public" },
      ...overrides,
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace release selection", () => {
  it("selects only public package identities", () => {
    expect(packageFor("@lamplitisles/dsh-mail")?.directory).toBe("dsh-mail");
    expect(packageFor("dsh-mail")?.name).toBe("@lamplitisles/dsh-mail");
    expect(PUBLIC_PACKAGES).toHaveLength(6);
  });

  it("rejects missing and malformed release input", () => {
    expect(() => parseReleaseRequest(["check"])).toThrow("Select exactly one public package");
    expect(() => parseReleaseRequest(["check", "dsh-mail", "0.1.0"])).toThrow("Release tags must use");
    expect(() => parseReleaseRequest(["publish", "dsh-mail", "v0.1.0"])).toThrow("Usage");
  });

  it("accepts the argument separator emitted by pnpm run", () => {
    expect(parseReleaseRequest(["check", "--", "dsh-mail", "v0.1.0"]).entry.name).toBe(
      "@lamplitisles/dsh-mail",
    );
  });

  it("keeps independent package versions and the npm channel mapping", async () => {
    const root = await fixture();
    expect(checkReleaseManifest(root, PUBLIC_PACKAGES[0], "v0.1.0")).toEqual([]);
    expect(npmDistTag("v0.1.0")).toBe("latest");
    expect(npmDistTag("v0.1.0-beta.1")).toBe("beta");
    expect(versionFromTag("v1.2.3-alpha01+build.1")).toBe("1.2.3-alpha01+build.1");
    expect(DSH_RC_VERSION).toBe("0.1.2-rc.1");
  });

  it("reports wrong Forgejo metadata before any host gate", async () => {
    const root = await fixture({ repository: { type: "git", url: "https://example.invalid/old.git" } });
    expect(checkReleaseManifest(root, PUBLIC_PACKAGES[0], "v0.1.0")).toContain(
      "@lamplitisles/dsh-companion has the wrong repository metadata.",
    );
  });
});
