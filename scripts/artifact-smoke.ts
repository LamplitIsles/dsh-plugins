import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dshInvocation } from "./dsh-web-smoke.mjs";
import {
  DSH_RC_VERSION,
  PUBLIC_PACKAGES,
  packageFor,
  type PublicPackage,
} from "./release-shared.js";

const root = resolve(import.meta.dirname, "..");

function dshCli(): string {
  const configured = process.env.DSH_CLI;
  if (configured && existsSync(configured)) return configured;
  throw new Error(
    `DSH_CLI must point to the official DSH ${DSH_RC_VERSION} executable.`,
  );
}

function selectedPackage(selector: string | undefined): PublicPackage[] {
  if (selector === undefined || selector === "all") return [...PUBLIC_PACKAGES];
  const entry = packageFor(selector);
  if (!entry) throw new Error(`Unknown public package ${selector}.`);
  return [entry];
}

const entries = selectedPackage(process.argv[2]);
const configuredCli = dshCli();
const invocation = dshInvocation(configuredCli);
// Exercise the same resolved entry that the npm bootstrap wizard passes.
const env = {
  ...process.env,
  DSH_CLI: invocation.args.at(-1) ?? configuredCli,
};
const version = execFileSync(
  invocation.command,
  [...invocation.args, "--version"],
  {
    encoding: "utf8",
    env,
  },
).trim();
if (version !== DSH_RC_VERSION) {
  throw new Error(
    `Expected DSH ${DSH_RC_VERSION}, got ${version || "unknown"}.`,
  );
}

for (const entry of entries) {
  console.log(`\n== ${entry.name}: packed Host/Loader smoke ==`);
  execFileSync(
    "corepack",
    ["pnpm", "--filter", entry.name, "run", "pack-smoke"],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
}
console.log(
  `\nPacked artifact smoke passed for ${entries.length} package${entries.length === 1 ? "" : "s"}.`,
);
