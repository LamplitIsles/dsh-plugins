import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      "@deepseek-ai/cordis",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/schemastery",
    ],
  },
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
