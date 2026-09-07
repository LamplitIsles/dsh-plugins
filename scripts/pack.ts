import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PUBLIC_PACKAGES,
  packageFor,
  packRelease,
  type PublicPackage,
} from "./release-shared.js";

const root = resolve(import.meta.dirname, "..");

function selectedPackage(selector: string | undefined): PublicPackage[] {
  if (selector === undefined || selector === "all") return [...PUBLIC_PACKAGES];
  const entry = packageFor(selector);
  if (!entry) {
    throw new Error(
      `Unknown public package ${selector}. Choose one of: ${PUBLIC_PACKAGES.map(({ name }) => name).join(", ")}.`,
    );
  }
  return [entry];
}

const [selector, requestedDestination] = process.argv.slice(2);
const destination = resolve(
  requestedDestination ?? process.env.RELEASE_ARTIFACT_DIR ?? ".release-artifacts",
);
await mkdir(destination, { recursive: true });

const artifacts = selectedPackage(selector).map((entry) => ({
  package: entry.name,
  artifact: packRelease(root, entry, destination),
}));
console.log(JSON.stringify({ destination, artifacts }, null, 2));
