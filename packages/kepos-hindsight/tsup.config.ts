import { defineConfig } from "tsup";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { compileCssModule } from "./scripts/css-modules.js";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-renderer/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/schemastery",
];
function cssModulesPlugin(): EsbuildPlugin {
  return {
    name: "kepos-hindsight-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.dshcss$/ }, async (args) => {
        const { css, classes } = await compileCssModule(args.path);
        const styleId = "@lamplitisles/kepos-hindsight/settings.module.css";
        return {
          loader: "js",
          contents: [
            `const css=${JSON.stringify(css)};`,
            `const styleId=${JSON.stringify(styleId)};`,
            "if(typeof document!=='undefined'&&!document.querySelector(`style[data-plugin-css=\"${styleId}\"]`)){const tag=document.createElement('style');tag.dataset.pluginCss=styleId;tag.textContent=css;document.head.appendChild(tag)}",
            `export default ${JSON.stringify(classes)};`,
          ].join("\n"),
        };
      });
    },
  };
}

export default defineConfig([
  {
    entry: { index: "src/index.ts", dsh: "src/dsh.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: true,
    clean: true,
    external: [...dshExternals, "react"],
  },
  {
    entry: { client: "src/client.ts" },
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    esbuildPlugins: [cssModulesPlugin()],
    external: ["react", ...dshExternals],
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/kepos-hindsight", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: "return module.exports; } });" },
  },
]);
