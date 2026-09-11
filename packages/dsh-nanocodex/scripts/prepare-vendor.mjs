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
import { dirname, join, relative, resolve } from "node:path";
import { prepareEngineArtifacts } from "./engine-artifacts.ts";

const packageDirectory = resolve(import.meta.dirname, "..");
const vendorDirectory = join(packageDirectory, "vendor");
const savedManifest = join(packageDirectory, ".prepack-manifest.json");
const savedDistDirectory = join(packageDirectory, ".prepack-dist");

function manifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    archive,
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

async function prepack() {
  if (existsSync(savedManifest) || existsSync(savedDistDirectory)) postpack();
  const archives = await prepareEngineArtifacts();
  rmSync(vendorDirectory, { recursive: true, force: true });
  const vendoredNanocodex = join(vendorDirectory, "nanocodex");
  const vendoredTools = join(vendorDirectory, "nanocodex-tools");
  extract(archives.nanocodex, vendoredNanocodex);
  extract(archives["nanocodex-tools"], vendoredTools);
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
}

if (process.argv[2] === "prepack") await prepack();
else if (process.argv[2] === "postpack") postpack();
else throw new Error(`unknown pack phase ${process.argv[2] ?? "<missing>"}`);
