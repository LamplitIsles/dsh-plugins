import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { compileCssModule } from "./packages/dsh-imagegen/scripts/css-modules.js";

export default defineConfig({
  resolve: {
    alias: {
      "@lamplitisles/imagegen-core": resolve(
        import.meta.dirname,
        "packages/imagegen-core/src/index.ts",
      ),
    },
  },
  plugins: [
    {
      name: "dsh-plugins-css-modules-test",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".module.dshcss")) return undefined;
        const { classes } = await compileCssModule(id);
        return `export default ${JSON.stringify(classes)};`;
      },
    },
  ],
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "packages/**/tests/**/*.test.ts",
    ],
    exclude: ["packages/dsh-companion/tests/e2e/**"],
    environment: "node",
    server: {
      deps: {
        inline: ["@deepseek-ai/dsh-client-ui-primitives"],
      },
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
