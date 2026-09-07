import { defineConfig } from "tsup";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { compileCssModule } from "./scripts/css-modules.js";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent/client",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-session-controller/client",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-api-workspace-controller/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-primitives/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-slots/client",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-workspace/client",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-workspace",
  "@deepseek-ai/schemastery",
  "react",
  "react/jsx-runtime"
];

function cssModulesPlugin(): EsbuildPlugin {
  return {
    name: "dsh-matrix-css-modules",
    setup(build) {
      build.onLoad({ filter: /\.module\.dshcss$/ }, async (args) => {
        const { css, classes } = await compileCssModule(args.path);
        const styleId = "@lamplitisles/dsh-matrix/matrix.module.css";
        return {
          loader: "js",
          contents: [
            `const css = ${JSON.stringify(css)};`,
            `const styleId = ${JSON.stringify(styleId)};`,
            "if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=\"${styleId}\"]`) === null) {",
            "  const tag = document.createElement('style');",
            "  tag.dataset.plugin = '@lamplitisles/dsh-matrix';",
            "  tag.dataset.pluginCss = styleId;",
            "  tag.textContent = css;",
            "  document.head.appendChild(tag);",
            "}",
            `export default ${JSON.stringify(classes)};`
          ].join("\n")
        };
      });
    }
  };
}

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: true,
    clean: true,
    external: dshExternals
  },
  {
    entry: { client: "src/client.ts" },
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    esbuildPlugins: [cssModulesPlugin()],
    external: dshExternals,
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/dsh-matrix", factory: (require) => { var module = { exports: {} }; var exports = module.exports;'
    },
    footer: { js: "return module.exports; } });" }
  }
]);
