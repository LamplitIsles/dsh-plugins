import { readFile } from "node:fs/promises";
import { transform } from "lightningcss";
export async function compileCssModule(filename: string) {
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
