import { defineConfig } from "tsup";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { compileCssModule } from "./scripts/css-modules.js";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-chat/client",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-renderer/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-session/client",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/schemastery",
  "react",
  "react/jsx-runtime"
];

function cssModulesPlugin(): EsbuildPlugin {
  return {
    name: "kepos-speech-css-modules",
    setup(build) {
      // tsup consumes `.css` as a global stylesheet before esbuild plugins run.
      // This extension routes the source through Lightning CSS's real module transform.
      build.onLoad({ filter: /\.module\.dshcss$/ }, async (args) => {
        const { css, classes } = await compileCssModule(args.path);
        const styleId = "@lamplitisles/kepos-speech/speech.module.css";
        return {
          loader: "js",
          contents: [
            `const css = ${JSON.stringify(css)};`,
            `const styleId = ${JSON.stringify(styleId)};`,
            "if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=\"${styleId}\"]`) === null) {",
            "  const tag = document.createElement('style');",
            "  tag.dataset.plugin = '@lamplitisles/kepos-speech';",
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
    entry: {
      index: "src/index.ts",
      core: "src/core.ts"
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
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
      js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/kepos-speech", factory: (require) => { var module = { exports: {} }; var exports = module.exports;'
    },
    footer: { js: "return module.exports; } });" }
  }
]);
