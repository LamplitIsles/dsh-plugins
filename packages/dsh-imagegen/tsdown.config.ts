import { rm } from "node:fs/promises";
import { defineConfig, type UserConfig } from "tsdown";
import { cssModulesPlugin } from "./scripts/css-modules.ts";

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

export default defineConfig(async (): Promise<UserConfig[]> => {
  await rm("dist", { recursive: true, force: true });
  return [
    {
      entry: { index: "src/index.ts" },
      format: "esm",
      platform: "node",
      dts: true,
      clean: false,
      deps: { neverBundle: external },
      outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    },
    {
      entry: { client: "src/client.ts" },
      format: "cjs",
      platform: "browser",
      target: "es2022",
      loader: { ".css": "text" },
      dts: true,
      clean: false,
      plugins: [
        cssModulesPlugin("@lamplitisles/dsh-imagegen/settings.module.css"),
      ],
      deps: { neverBundle: external },
      outExtensions: () => ({ js: ".js", dts: ".d.cts" }),
      banner: {
        js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/dsh-imagegen", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      },
      footer: { js: "return module.exports; } });" },
    },
  ];
});
