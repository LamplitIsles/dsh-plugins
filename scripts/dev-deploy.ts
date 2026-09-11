import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_PACKAGES,
  packageDirectory,
  packageFor,
  packRelease,
  readJson,
  type PublicPackage,
} from "./release-shared.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The accepted Nanocodex package contains a 26 MiB WASM member. Keep tar
// extraction bounded while allowing the largest current packed member.
const MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024;

export interface DevDeploymentTarget {
  readonly dshCli: string;
  readonly dshHome: string;
  readonly runtimeRoot: string;
  readonly profile: string;
  readonly service: string;
  readonly port: number;
}

export const DEFAULT_DEV_TARGET: DevDeploymentTarget = Object.freeze({
  dshCli: "/home/neil/.local/share/dsh-dev-runtime/node_modules/.bin/dsh",
  dshHome: "/home/neil/.local/state/dsh-dev",
  runtimeRoot: "/home/neil/.local/share/dsh-dev-runtime",
  profile: "web",
  service: "dsh-dev.service",
  port: 3081,
});

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

export interface ParsedDevDeployArgs {
  readonly selectors: readonly string[];
  readonly updateAll: boolean;
  readonly help: boolean;
}

export function parseDevDeployArgs(
  argv: readonly string[],
): ParsedDevDeployArgs {
  const arguments_ = argv[0] === "--" ? argv.slice(1) : [...argv];
  const updateAll = arguments_.includes("--all");
  const selectors = arguments_.filter((argument) => argument !== "--all");
  const help = selectors.includes("--help") || selectors.includes("-h");
  if (help) return { selectors, updateAll, help: true };
  if (selectors.some((selector) => selector.startsWith("-"))) {
    fail(
      `unknown option: ${selectors.find((selector) => selector.startsWith("-"))}`,
    );
  }
  if (selectors.length === 0 && !updateAll) {
    fail("select at least one affected package, or pass --all explicitly");
  }
  return { selectors, updateAll, help: false };
}

export function resolveDevTarget(
  environment: NodeJS.ProcessEnv = process.env,
): DevDeploymentTarget {
  const overrides: readonly [keyof DevDeploymentTarget, string][] = [
    ["dshCli", "DSH_CLI"],
    ["dshHome", "DSH_HOME"],
    ["runtimeRoot", "DSH_RUNTIME"],
  ];
  for (const [field, variable] of overrides) {
    const value = environment[variable];
    if (value !== undefined && resolve(value) !== DEFAULT_DEV_TARGET[field]) {
      fail(
        `${variable} is not the fixed persistent dev target; ` +
          `expected ${DEFAULT_DEV_TARGET[field]}`,
      );
    }
  }
  return DEFAULT_DEV_TARGET;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "pipe";
  },
) => string;

export const command: CommandRunner = (
  executable,
  args,
  options = {},
): string => {
  const output = execFileSync(executable, [...args], {
    cwd: options.cwd ?? root,
    ...(options.env === undefined ? {} : { env: options.env }),
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  return typeof output === "string" ? output.trim() : "";
};

function requirePath(path: string, description: string): void {
  if (!existsSync(path)) fail(`${description} does not exist: ${path}`);
}

function packageManifest(profileDirectory: string): JsonObject {
  const path = join(profileDirectory, "package.json");
  requirePath(path, "persistent dev profile manifest");
  return readJson(path);
}

function installedEntries(manifest: JsonObject): PublicPackage[] {
  const dependencies = manifest.dependencies;
  if (dependencies === null || typeof dependencies !== "object") {
    fail("persistent dev profile has no dependencies to update");
  }
  const names = new Set(Object.keys(dependencies as JsonObject));
  return PUBLIC_PACKAGES.filter((entry) => names.has(entry.name));
}

function selectEntries(
  manifest: JsonObject,
  selectors: readonly string[],
  updateAll: boolean,
  profileName: string,
): PublicPackage[] {
  const available = installedEntries(manifest);
  const availableNames = new Set(available.map((entry) => entry.name));
  if (updateAll) return available;

  const selected: PublicPackage[] = [];
  for (const selector of selectors) {
    const entry = packageFor(
      selector.startsWith("packages/")
        ? selector.slice("packages/".length)
        : selector,
    );
    if (entry === undefined) fail(`unknown public package: ${selector}`);
    if (!availableNames.has(entry.name)) {
      fail(
        `${entry.name} is not installed in the persistent dev ${profileName} profile; ` +
          "dev:deploy only updates existing profile plugins",
      );
    }
    if (!selected.some((candidate) => candidate.name === entry.name)) {
      selected.push(entry);
    }
  }
  return selected;
}

function profileDependencyPath(
  profileDirectory: string,
  specification: unknown,
): string | undefined {
  if (typeof specification !== "string") return undefined;
  const value = specification.startsWith("file:")
    ? specification.slice("file:".length)
    : specification;
  if (!value.startsWith("/") && !value.startsWith(".")) return undefined;
  return resolve(profileDirectory, value);
}

function dependencyMap(manifest: JsonObject): Record<string, unknown> {
  const dependencies = manifest.dependencies;
  return dependencies !== null && typeof dependencies === "object"
    ? (dependencies as Record<string, unknown>)
    : {};
}

function assertUnselectedDependenciesUnchanged(
  before: JsonObject,
  after: JsonObject,
  selected: readonly PublicPackage[],
): void {
  const selectedNames = new Set<string>(selected.map((entry) => entry.name));
  const beforeDependencies = dependencyMap(before);
  const afterDependencies = dependencyMap(after);
  for (const [name, specification] of Object.entries(beforeDependencies)) {
    if (selectedNames.has(name)) continue;
    if (afterDependencies[name] !== specification) {
      fail(`dev deployment changed unrelated dependency ${name}`);
    }
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function installedPackageManifest(
  profileDirectory: string,
  entry: PublicPackage,
): JsonObject {
  const packagePath = join(
    profileDirectory,
    "node_modules",
    "@lamplitisles",
    entry.directory,
    "package.json",
  );
  requirePath(packagePath, `${entry.name} installed package manifest`);
  return readJson(packagePath);
}

function archiveFilePaths(archive: string): readonly string[] {
  const entries = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length));
  for (const entry of entries) {
    if (!entry || entry.startsWith("/") || entry.split("/").includes("..")) {
      fail(`packed artifact contains an unsafe path: ${entry}`);
    }
  }
  return entries;
}

function archiveFile(archive: string, path: string): Buffer {
  return execFileSync("tar", ["-xOzf", archive, `package/${path}`], {
    maxBuffer: MAX_ARCHIVE_MEMBER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyInstalledArtifactBytes(
  profileDirectory: string,
  entry: PublicPackage,
  archive: string,
): void {
  const installedDirectory = join(
    profileDirectory,
    "node_modules",
    "@lamplitisles",
    entry.directory,
  );
  const archivePaths = archiveFilePaths(archive);
  for (const required of entry.requiredFiles) {
    if (!archivePaths.includes(required)) {
      fail(`${entry.name} artifact omits required file ${required}`);
    }
  }
  for (const path of archivePaths) {
    const installed = join(installedDirectory, path);
    requirePath(installed, `${entry.name} installed artifact file`);
    if (
      sha256Bytes(readFileSync(installed)) !==
      sha256Bytes(archiveFile(archive, path))
    ) {
      fail(`${entry.name} installed artifact is stale at ${path}`);
    }
  }
}

function verifyInstalledArtifacts(
  workspaceRoot: string,
  profileDirectory: string,
  after: JsonObject,
  artifacts: readonly { entry: PublicPackage; path: string }[],
): void {
  const dependencies = dependencyMap(after);
  for (const { entry, path } of artifacts) {
    const dependencyPath = profileDependencyPath(
      profileDirectory,
      dependencies[entry.name],
    );
    if (dependencyPath !== resolve(path)) {
      fail(
        `${entry.name} profile dependency does not point at the deployed artifact ` +
          `(${String(dependencies[entry.name])})`,
      );
    }
    const manifest = installedPackageManifest(profileDirectory, entry);
    if (manifest.name !== entry.name) {
      fail(`${entry.name} installed artifact has the wrong package name`);
    }
    const sourceManifest = readJson(
      join(packageDirectory(workspaceRoot, entry), "package.json"),
    );
    if (manifest.version !== sourceManifest.version) {
      fail(
        `${entry.name} installed version ${String(manifest.version)} does not ` +
          `match source version ${String(sourceManifest.version)}`,
      );
    }
    verifyInstalledArtifactBytes(profileDirectory, entry, path);
  }
}

function backupProfile(
  profileDirectory: string,
  destination: string,
): string[] {
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "cordis.patch.yml",
    "cordis.yml",
  ];
  const copied: string[] = [];
  for (const file of files) {
    const source = join(profileDirectory, file);
    if (!existsSync(source)) continue;
    const target = join(destination, file);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
    copied.push(file);
  }
  return copied;
}

function isServiceActive(
  unit: string,
  run: CommandRunner,
  environment: NodeJS.ProcessEnv,
): boolean {
  try {
    run("systemctl", ["--user", "is-active", "--quiet", unit], {
      env: environment,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(
  unit: string,
  url: string,
  run: CommandRunner,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (isServiceActive(unit, run, environment)) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.status === 401) return;
      } catch {
        // The service may still be binding its loopback port.
      }
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  fail(`persistent dev service did not become ready at ${url}`);
}

function printUsage(): void {
  console.log(
    [
      "Usage: pnpm run dev:deploy -- [package ...]",
      "",
      "Build and install selected plugins into the existing persistent dsh-dev",
      "profile, then restart only dsh-dev.service.",
      "",
      "Package arguments accept a public package name or packages/<directory>.",
      "Pass at least one affected package; use --all only when every installed",
      "public plugin is affected.",
      "The script never provisions a runtime, DSH_HOME, or profile.",
    ].join("\n"),
  );
}

export interface DevDeploymentDependencies {
  readonly run?: CommandRunner;
  readonly buildPackage?: (
    entry: PublicPackage,
    workspaceRoot: string,
    environment: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
  readonly packPackage?: (
    workspaceRoot: string,
    entry: PublicPackage,
    destination: string,
  ) => string | Promise<string>;
  readonly waitForReady?: (
    service: string,
    url: string,
    environment: NodeJS.ProcessEnv,
  ) => void | Promise<void>;
}

export interface DevDeploymentOptions {
  readonly selectors: readonly string[];
  readonly updateAll: boolean;
  readonly workspaceRoot?: string;
  readonly target?: DevDeploymentTarget;
  readonly environment?: NodeJS.ProcessEnv;
  readonly dependencies?: DevDeploymentDependencies;
}

export async function deployDevArtifacts(
  options: DevDeploymentOptions,
): Promise<void> {
  const workspaceRoot = options.workspaceRoot ?? root;
  const target = options.target ?? DEFAULT_DEV_TARGET;
  const environment = options.environment ?? process.env;
  const childEnvironment = { ...environment, DSH_HOME: target.dshHome };
  const dependencies = options.dependencies ?? {};
  const run = dependencies.run ?? command;
  const profileDirectory = join(target.dshHome, "profiles", target.profile);
  requirePath(target.dshCli, "persistent dev DSH executable");
  requirePath(target.dshHome, "persistent dev DSH_HOME");
  requirePath(target.runtimeRoot, "persistent dev runtime");
  requirePath(
    join(target.runtimeRoot, "artifacts"),
    "persistent dev artifact store",
  );
  requirePath(profileDirectory, "persistent dev profile");
  requirePath(
    join(profileDirectory, "package.json"),
    "persistent dev profile manifest",
  );

  const workspaceManifest = readJson(join(workspaceRoot, "package.json"));
  const packageManager = workspaceManifest.packageManager;
  const expectedPnpmVersion =
    typeof packageManager === "string" && packageManager.startsWith("pnpm@")
      ? packageManager.slice("pnpm@".length)
      : undefined;
  if (expectedPnpmVersion === undefined) {
    fail("root package.json must pin pnpm through packageManager");
  }
  const pnpmVersion = run("pnpm", ["--version"], {
    cwd: workspaceRoot,
    env: childEnvironment,
  });
  if (pnpmVersion !== expectedPnpmVersion) {
    fail(
      `PATH pnpm is ${pnpmVersion}, but root packageManager requires ${expectedPnpmVersion}; ` +
        "enable the Corepack pnpm shim before deploying",
    );
  }

  const before = packageManifest(profileDirectory);
  const entries = selectEntries(
    before,
    options.selectors,
    options.updateAll,
    target.profile,
  );
  if (entries.length === 0)
    fail("persistent dev profile has no public plugins");
  console.log(`Building ${entries.map((entry) => entry.name).join(", ")}...`);
  const buildPackage =
    dependencies.buildPackage ??
    ((entry: PublicPackage, sourceRoot: string, env: NodeJS.ProcessEnv) => {
      run("pnpm", ["--filter", entry.name, "run", "build"], {
        cwd: sourceRoot,
        env,
        stdio: "inherit",
      });
    });
  for (const entry of entries) {
    await buildPackage(entry, workspaceRoot, childEnvironment);
    for (const file of entry.requiredFiles) {
      requirePath(
        join(packageDirectory(workspaceRoot, entry), file),
        `${entry.name} build output`,
      );
    }
  }

  const artifactDirectory = await mkdtemp(
    join(target.runtimeRoot, "artifacts", "dev-deploy-"),
  );
  const artifacts: { entry: PublicPackage; path: string }[] = [];
  try {
    const packPackage =
      dependencies.packPackage ??
      ((sourceRoot: string, entry: PublicPackage, destination: string) =>
        packRelease(sourceRoot, entry, destination));
    for (const entry of entries) {
      artifacts.push({
        entry,
        path: await packPackage(workspaceRoot, entry, artifactDirectory),
      });
    }

    const backupDirectory = await mkdtemp(
      join(target.runtimeRoot, "artifacts", "dev-deploy-backup-"),
    );
    const backupFiles = backupProfile(profileDirectory, backupDirectory);
    const artifactIdentity = {
      profile: target.profile,
      service: target.service,
      port: target.port,
      packages: artifacts.map(({ entry, path }) => ({
        name: entry.name,
        version: readJson(
          join(packageDirectory(workspaceRoot, entry), "package.json"),
        ).version,
        artifact: basename(path),
        sha256: sha256(path),
      })),
    };
    writeFileSync(
      join(artifactDirectory, "identity.json"),
      JSON.stringify(artifactIdentity, null, 2) + "\n",
      { mode: 0o600 },
    );

    console.log(`Stopping ${target.service} for the profile update...`);
    run("systemctl", ["--user", "stop", target.service], {
      env: childEnvironment,
      stdio: "inherit",
    });
    try {
      run(
        target.dshCli,
        [
          "plugin",
          "--profile",
          target.profile,
          "add",
          "--save-exact",
          "--ignore-scripts",
          ...artifacts.map(({ path }) => path),
        ],
        { cwd: workspaceRoot, env: childEnvironment, stdio: "inherit" },
      );
      const after = packageManifest(profileDirectory);
      assertUnselectedDependenciesUnchanged(before, after, entries);
      verifyInstalledArtifacts(
        workspaceRoot,
        profileDirectory,
        after,
        artifacts,
      );
      run("systemctl", ["--user", "restart", target.service], {
        env: childEnvironment,
        stdio: "inherit",
      });
      if (dependencies.waitForReady) {
        await dependencies.waitForReady(
          target.service,
          `http://127.0.0.1:${target.port}/`,
          childEnvironment,
        );
      } else {
        await waitForReady(
          target.service,
          `http://127.0.0.1:${target.port}/`,
          run,
          childEnvironment,
        );
      }
    } catch (error) {
      try {
        run("systemctl", ["--user", "stop", target.service], {
          env: childEnvironment,
        });
      } catch {
        // Keep the original failure and report the retained backup below.
      }
      throw error;
    }

    console.log(
      JSON.stringify(
        {
          deployed: artifacts.map(({ entry, path }) => ({
            package: entry.name,
            artifact: path,
            sha256: sha256(path),
          })),
          service: target.service,
          ready: true,
          url: `http://127.0.0.1:${target.port}/`,
          profileBackup: backupDirectory,
          backedUpFiles: backupFiles,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      `Development deployment failed; artifacts: ${artifactDirectory}`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const parsed = parseDevDeployArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  await deployDevArtifacts({
    selectors: parsed.selectors,
    updateAll: parsed.updateAll,
    target: resolveDevTarget(),
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === root + "/scripts/dev-deploy.ts"
) {
  await main();
}
