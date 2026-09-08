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
      "@deepseek-ai/dsh-credentials",
      "@deepseek-ai/dsh-fs",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-llm-pi-ai",
      "@deepseek-ai/dsh-scope",
      "@deepseek-ai/dsh-settings",
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/schemastery",
    ],
  },
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
