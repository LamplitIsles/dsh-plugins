import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  clean: true,
  external: [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/schemastery",
  ],
});
