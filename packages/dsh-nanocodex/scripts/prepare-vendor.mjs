import { execFileSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const vendorDirectory = join(packageDirectory, "vendor");
const temporaryDirectory = join(packageDirectory, ".prepack-vendor");
const savedManifest = join(packageDirectory, ".prepack-manifest.json");
const savedDistDirectory = join(packageDirectory, ".prepack-dist");
const nanocodexDirectory = resolve(
  packageDirectory,
  "../../../nanocodex/js/nanocodex",
);
const toolsDirectory = resolve(
  packageDirectory,
  "../../../nanocodex/js/nanocodex-tools",
);

function manifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function pack(directory) {
  const output = execFileSync(
    "corepack",
    ["pnpm", "pack", "--json", "--pack-destination", temporaryDirectory],
    { cwd: directory, encoding: "utf8" },
  );
  const jsonStart = output.lastIndexOf("\n{");
  const value = JSON.parse(output.slice(jsonStart < 0 ? 0 : jsonStart + 1));
  const entry = Array.isArray(value)
    ? value[0]
    : value &&
        typeof value === "object" &&
        ("filename" in value || "files" in value)
      ? value
      : Object.values(value)[0];
  if (!entry || typeof entry.filename !== "string") {
    throw new Error(`pnpm pack did not return an archive for ${directory}`);
  }
  return basename(entry.filename);
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(temporaryDirectory, archive),
    "-C",
    destination,
    "--strip-components=1",
  ]);
}

function exportedPath(toolsManifest, subpath, condition) {
  const key = subpath ? `./${subpath}` : ".";
  const value = toolsManifest.exports?.[key];
  const path = typeof value === "string" ? value : value?.[condition];
  if (typeof path !== "string") {
    throw new Error(`nanocodex-tools does not export ${key} for ${condition}`);
  }
  return path;
}

function rewriteToolsImports(directory, toolsDirectory, toolsManifest) {
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".mts"))
        continue;
      const source = readFileSync(path, "utf8");
      const rewritten = source.replaceAll(
        /(["'])nanocodex-tools(?:\/([^"']+))?\1/g,
        (_match, quote, subpath) =>
          `${quote}${relative(
            dirname(path),
            join(
              toolsDirectory,
              exportedPath(
                toolsManifest,
                subpath,
                entry.name.endsWith(".mts") ? "types" : "import",
              ),
            ),
          ).replaceAll("\\", "/")}${quote}`,
      );
      if (rewritten !== source) writeFileSync(path, rewritten);
    }
  };
  walk(directory);
}

function rewriteAdapterImports() {
  for (const name of ["index.js", "index.d.ts"]) {
    const path = join(packageDirectory, "dist", name);
    const source = readFileSync(path, "utf8");
    const rewritten = source.replaceAll(
      '"nanocodex/node"',
      name.endsWith(".d.ts")
        ? '"../vendor/nanocodex/node/index.d.mts"'
        : '"../vendor/nanocodex/node/index.mjs"',
    );
    if (rewritten === source) {
      throw new Error(`built adapter ${name} does not import nanocodex/node`);
    }
    writeFileSync(path, rewritten);
  }
}

function prepack() {
  if (existsSync(savedManifest) || existsSync(savedDistDirectory)) postpack();
  if (!existsSync(nanocodexDirectory) || !existsSync(toolsDirectory)) {
    throw new Error(
      "dsh-nanocodex packing requires the sibling nanocodex checkout at the accepted local path",
    );
  }
  rmSync(vendorDirectory, { recursive: true, force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  const nanocodexArchive = pack(nanocodexDirectory);
  const toolsArchive = pack(toolsDirectory);
  const vendoredNanocodex = join(vendorDirectory, "nanocodex");
  const vendoredTools = join(vendorDirectory, "nanocodex-tools");
  extract(nanocodexArchive, vendoredNanocodex);
  extract(toolsArchive, vendoredTools);
  const toolsManifest = manifest(vendoredTools);
  rewriteToolsImports(vendoredNanocodex, vendoredTools, toolsManifest);
  rmSync(savedDistDirectory, { recursive: true, force: true });
  mkdirSync(savedDistDirectory, { recursive: true });
  for (const name of ["index.js", "index.d.ts"]) {
    copyFileSync(
      join(packageDirectory, "dist", name),
      join(savedDistDirectory, name),
    );
  }
  rewriteAdapterImports();
  const current = manifest(packageDirectory);
  writeFileSync(savedManifest, `${JSON.stringify(current, null, 2)}\n`);
  const nanocodexManifest = manifest(vendoredNanocodex);
  const dependencies = { ...current.dependencies };
  delete dependencies.nanocodex;
  delete dependencies["nanocodex-tools"];
  for (const source of [
    nanocodexManifest.dependencies,
    toolsManifest.dependencies,
  ]) {
    for (const [name, version] of Object.entries(source ?? {})) {
      if (name !== "nanocodex-tools") dependencies[name] = version;
    }
  }
  const next = {
    ...current,
    files: [
      ...new Set([
        ...(current.files ?? []),
        "vendor",
        "THIRD_PARTY_NOTICES.md",
      ]),
    ],
    dependencies: {
      ...dependencies,
    },
  };
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function postpack() {
  for (const name of ["index.js", "index.d.ts"]) {
    const saved = join(savedDistDirectory, name);
    if (existsSync(saved))
      copyFileSync(saved, join(packageDirectory, "dist", name));
  }
  rmSync(savedDistDirectory, { recursive: true, force: true });
  if (existsSync(savedManifest)) {
    writeFileSync(
      join(packageDirectory, "package.json"),
      `${readFileSync(savedManifest, "utf8").trimEnd()}\n`,
    );
    rmSync(savedManifest, { force: true });
  }
  rmSync(vendorDirectory, { recursive: true, force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (process.argv[2] === "prepack") prepack();
else if (process.argv[2] === "postpack") postpack();
else throw new Error(`unknown pack phase ${process.argv[2] ?? "<missing>"}`);
