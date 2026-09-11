import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deployDevArtifacts,
  parseDevDeployArgs,
  resolveDevTarget,
  type CommandRunner,
  type DevDeploymentTarget,
} from "../scripts/dev-deploy.js";
import { packageFor } from "../scripts/release-shared.js";

const entry = packageFor("dsh-tabletop")!;

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "dsh-dev-deploy-test-"));
  const workspaceRoot = join(temporary, "workspace");
  const dshHome = join(temporary, "dsh-home");
  const runtimeRoot = join(temporary, "dsh-runtime");
  const profileDirectory = join(dshHome, "profiles", "web");
  const packageDirectory = join(workspaceRoot, "packages", entry.directory);
  const installedDirectory = join(
    profileDirectory,
    "node_modules",
    "@lamplitisles",
    entry.directory,
  );
  const target: DevDeploymentTarget = {
    dshCli: join(temporary, "bin", "dsh"),
    dshHome,
    runtimeRoot,
    profile: "web",
    service: "test-dsh-dev.service",
    port: 39871,
  };
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await mkdir(join(runtimeRoot, "artifacts"), { recursive: true });
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(join(target.dshCli, ".."), { recursive: true });
  await writeFile(target.dshCli, "test executable\n");
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ packageManager: "pnpm@12.3.4" }),
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: entry.name, version: "0.0.1" }),
  );
  for (const file of entry.requiredFiles) {
    const path = join(packageDirectory, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `fixture:${file}\n`);
  }
  await writeFile(
    join(packageDirectory, "dist", "fixture-large-wasm.bin"),
    Buffer.alloc(2 * 1024 * 1024, 0x5a),
  );
  await writeFile(
    join(profileDirectory, "package.json"),
    JSON.stringify({
      name: "fixture-profile",
      dependencies: {
        [entry.name]: "file:../old-artifact.tgz",
        "@lamplitisles/dsh-mail": "file:../unrelated-artifact.tgz",
      },
    }),
  );
  await cp(packageDirectory, installedDirectory, { recursive: true });

  const events: string[] = [];
  const calls: {
    executable: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const packPackage = async (
    _root: string,
    _entry: typeof entry,
    destination: string,
  ) => {
    const packageRoot = join(destination, "package");
    await cp(packageDirectory, packageRoot, { recursive: true });
    const artifact = join(destination, "dsh-tabletop.tgz");
    execFileSync("tar", ["-czf", artifact, "-C", destination, "package"]);
    return artifact;
  };
  const makeRun =
    (failInstall = false): CommandRunner =>
    (executable, args, options = {}) => {
      calls.push({ executable, args, env: options.env });
      if (executable === "pnpm" && args[0] === "--version") return "12.3.4";
      if (executable === "systemctl" && args.includes("stop")) {
        events.push("stop");
        return "";
      }
      if (executable === "systemctl" && args.includes("restart")) {
        events.push("restart");
        return "";
      }
      if (executable === target.dshCli && args.includes("add")) {
        events.push("install");
        if (failInstall) throw new Error("fixture install failed");
        const artifact = args.at(-1)!;
        const manifestPath = join(profileDirectory, "package.json");
        const manifest = JSON.parse(awaitRead(manifestPath)) as {
          dependencies: Record<string, string>;
        };
        manifest.dependencies[entry.name] = `file:${artifact}`;
        writeText(manifestPath, JSON.stringify(manifest));
        return "";
      }
      return "";
    };

  return {
    temporary,
    workspaceRoot,
    dshHome,
    runtimeRoot,
    profileDirectory,
    installedDirectory,
    largeInstalledPath: join(
      installedDirectory,
      "dist",
      "fixture-large-wasm.bin",
    ),
    target,
    events,
    calls,
    packPackage,
    makeRun,
  };
}

function awaitRead(path: string): string {
  return readFileSync(path, "utf8");
}

function writeText(path: string, value: string): void {
  writeFileSync(path, value);
}

describe("persistent dev deployment workflow", () => {
  it("parses the forwarded separator and rejects non-dev target overrides", () => {
    expect(parseDevDeployArgs(["--", "@lamplitisles/dsh-tabletop"])).toEqual({
      selectors: ["@lamplitisles/dsh-tabletop"],
      updateAll: false,
      help: false,
    });
    expect(() => resolveDevTarget({ DSH_HOME: "/tmp/staging-home" })).toThrow(
      /fixed persistent dev target/u,
    );
  });

  it("builds before stopping, binds DSH_HOME, installs bytes, and starts once", async () => {
    const value = await fixture();
    try {
      const buildEvents: string[] = value.events;
      await deployDevArtifacts({
        selectors: [entry.name],
        updateAll: false,
        workspaceRoot: value.workspaceRoot,
        target: value.target,
        environment: { DSH_HOME: "/tmp/staging-home" },
        dependencies: {
          run: value.makeRun(),
          buildPackage: async () => {
            buildEvents.push("build");
          },
          packPackage: value.packPackage,
          waitForReady: async () => {
            buildEvents.push("ready");
          },
        },
      });
      expect(value.events).toEqual([
        "build",
        "stop",
        "install",
        "restart",
        "ready",
      ]);
      const install = value.calls.find(
        (call) => call.executable === value.target.dshCli,
      );
      expect(install?.env?.DSH_HOME).toBe(value.target.dshHome);
      expect(awaitRead(join(value.profileDirectory, "package.json"))).toContain(
        "dsh-tabletop.tgz",
      );
      expect(awaitRead(join(value.installedDirectory, "dist/index.js"))).toBe(
        "fixture:dist/index.js\n",
      );
      expect(readFileSync(value.largeInstalledPath)).toHaveLength(
        2 * 1024 * 1024,
      );
    } finally {
      await rm(value.temporary, { recursive: true, force: true });
    }
  });

  it("leaves the service stopped when installation fails", async () => {
    const value = await fixture();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        deployDevArtifacts({
          selectors: [entry.name],
          updateAll: false,
          workspaceRoot: value.workspaceRoot,
          target: value.target,
          dependencies: {
            run: value.makeRun(true),
            buildPackage: async () => {
              value.events.push("build");
            },
            packPackage: value.packPackage,
            waitForReady: async () => {
              value.events.push("ready");
            },
          },
        }),
      ).rejects.toThrow("fixture install failed");
      expect(value.events).toEqual(["build", "stop", "install", "stop"]);
      expect(value.events).not.toContain("restart");
      expect(value.events).not.toContain("ready");
    } finally {
      error.mockRestore();
      await rm(value.temporary, { recursive: true, force: true });
    }
  });

  it("rejects stale bytes after verifying a large packed member", async () => {
    const value = await fixture();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await writeFile(
        value.largeInstalledPath,
        Buffer.alloc(2 * 1024 * 1024, 0x41),
      );
      await expect(
        deployDevArtifacts({
          selectors: [entry.name],
          updateAll: false,
          workspaceRoot: value.workspaceRoot,
          target: value.target,
          dependencies: {
            run: value.makeRun(),
            buildPackage: async () => {
              value.events.push("build");
            },
            packPackage: value.packPackage,
          },
        }),
      ).rejects.toThrow(
        "installed artifact is stale at dist/fixture-large-wasm.bin",
      );
      expect(value.events).toEqual(["build", "stop", "install", "stop"]);
      expect(value.events).not.toContain("restart");
    } finally {
      error.mockRestore();
      await rm(value.temporary, { recursive: true, force: true });
    }
  });
});
