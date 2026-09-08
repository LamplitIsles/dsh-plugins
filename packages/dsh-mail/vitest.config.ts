import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

function cssModule(): Plugin {
  return {
    name: "dsh-mail-test-css-module",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(".module.css") || !importer) return undefined;
      return resolve(dirname(importer), source);
    },
    load(id) {
      if (!id.endsWith(".module.css")) return undefined;
      const source = readFileSync(id, "utf8");
      const names = [...source.matchAll(/^\.([A-Za-z][\w-]*)/gmu)].map(
        (match) => match[1],
      );
      return `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))};`;
    },
  };
}

export default defineConfig({
  plugins: [cssModule()],
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
  },
});
