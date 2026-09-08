import { rm } from "node:fs/promises";
import { defineConfig, type UserConfig } from "tsdown";
import { cssModulesPlugin } from "./scripts/css-modules.ts";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-chat/client",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-conversation/client",
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
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/schemastery",
  "react",
  "react/jsx-runtime",
];

export default defineConfig(async (): Promise<UserConfig[]> => {
  await rm("dist", { recursive: true, force: true });
  return [
    {
      entry: { index: "src/index.ts", core: "src/core.ts" },
      format: "esm",
      platform: "node",
      target: "node20",
      dts: true,
      clean: false,
      deps: { neverBundle: dshExternals },
      outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    },
    {
      entry: { client: "src/client.ts" },
      format: "cjs",
      platform: "browser",
      target: "es2022",
      dts: true,
      clean: false,
      plugins: [cssModulesPlugin("@lamplitisles/dsh-speech/speech.module.css")],
      deps: { neverBundle: dshExternals },
      outExtensions: () => ({ js: ".js", dts: ".d.cts" }),
      banner: {
        js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/dsh-speech", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      },
      footer: { js: "return module.exports; } });" },
    },
  ];
});
