import { defineConfig } from "tsup";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { compileCssModule } from "./scripts/css-modules.js";

const external = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/schemastery",
  "react",
  "react-dom",
];
function cssModulesPlugin(): EsbuildPlugin {
  return {
    name: "kepos-imagegen-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.dshcss$/ }, async (args) => {
        const { css, classes } = await compileCssModule(args.path);
        const styleId = "@lamplitisles/dsh-imagegen/settings.module.css";
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
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    dts: true,
    clean: true,
    external,
    noExternal: ["@lamplitisles/imagegen-core"],
  },
  {
    entry: { client: "src/client.ts" },
    format: ["cjs"],
    platform: "browser",
    loader: { ".css": "text" },
    dts: true,
    esbuildPlugins: [cssModulesPlugin()],
    external,
    noExternal: ["@lamplitisles/imagegen-core"],
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/dsh-imagegen", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: "return module.exports; } });" },
  },
]);
