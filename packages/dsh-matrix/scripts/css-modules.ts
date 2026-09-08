import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transform } from "lightningcss";
import type { TsdownPlugin } from "tsdown";

export interface CompiledCssModule {
  css: string;
  classes: Record<string, string>;
}

export async function compileCssModule(
  filename: string,
): Promise<CompiledCssModule> {
  const result = transform({
    filename,
    code: await readFile(filename),
    cssModules: true,
    minify: true,
  });
  return {
    css: result.code.toString(),
    classes: Object.fromEntries(
      Object.entries(result.exports ?? {}).map(([name, value]) => [
        name,
        value.name,
      ]),
    ),
  };
}

const virtualCssPrefix = "\0dsh-matrix-css:";

export function cssModulesPlugin(styleId: string): TsdownPlugin {
  return {
    name: "dsh-matrix-css-modules",
    resolveId(source, importer) {
      if (!importer || !source.endsWith(".css")) return null;
      return `${virtualCssPrefix}${resolve(dirname(importer), source)}?dsh-css`;
    },
    async load(id) {
      if (!id.startsWith(virtualCssPrefix)) return null;
      const filename = id
        .slice(virtualCssPrefix.length)
        .replace(/\?dsh-css$/u, "");
      if (!filename.endsWith(".module.css")) {
        return {
          code: `export default ${JSON.stringify(await readFile(filename, "utf8"))};`,
          moduleType: "js",
          moduleSideEffects: true,
        };
      }
      const { css, classes } = await compileCssModule(filename);
      return {
        code: [
          `const css = ${JSON.stringify(css)};`,
          `const styleId = ${JSON.stringify(styleId)};`,
          "if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=\\\"${styleId}\\\"]`) === null) {",
          "  const tag = document.createElement('style');",
          "  tag.dataset.plugin = '@lamplitisles/dsh-matrix';",
          "  tag.dataset.pluginCss = styleId;",
          "  tag.textContent = css;",
          "  document.head.appendChild(tag);",
          "}",
          `export default ${JSON.stringify(classes)};`,
        ].join("\n"),
        moduleType: "js",
        moduleSideEffects: true,
      };
    },
  };
}
