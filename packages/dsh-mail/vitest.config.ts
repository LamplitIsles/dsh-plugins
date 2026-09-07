import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

function dshCssModule(): Plugin {
  return {
    name: "dsh-mail-test-css",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(".dshcss") || !importer) return undefined;
      return resolve(dirname(importer), source);
    },
    load(id) {
      if (!id.endsWith(".dshcss")) return undefined;
      const source = readFileSync(id, "utf8");
      const names = [...source.matchAll(/^\.([A-Za-z][\w-]*)/gmu)].map((match) => match[1]);
      return `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))};`;
    }
  };
}

export default defineConfig({
  plugins: [dshCssModule()],
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true
  }
});
