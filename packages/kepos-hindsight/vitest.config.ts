import { defineConfig } from "vitest/config";
import { compileCssModule } from "./scripts/css-modules.js";

export default defineConfig({
  plugins: [
    {
      name: "kepos-hindsight-css-modules-test",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".module.dshcss")) return undefined;
        const { classes } = await compileCssModule(id);
        return `export default ${JSON.stringify(classes)};`;
      },
    },
  ],
  test: {
    server: { deps: { inline: ["@deepseek-ai/dsh-client-ui-primitives"] } },
  },
});
