import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import Include from "@deepseek-ai/cordis-plugin-include";

const require = createRequire(import.meta.url);
const officialPresetPath = pathToFileURL(
  join(
    dirname(require.resolve("@deepseek-ai/dsh-agent-presets/package.json")),
    "presets",
    "standard",
    "agent.cordis.yml",
  ),
).href;

const patches = [
  { id: "compaction-basic", disabled: true },
  { id: "command-compact", disabled: true },
];

export const name = "dsh-nanocodex-standard-preset";
export const inject = ["loader"] as const;

/** Mount the official standard composition with Nanocodex's owner overlay. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(Include, { path: officialPresetPath, patches });
}
