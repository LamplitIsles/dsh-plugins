import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("DSH bundle manifest", () => {
  it("uses the package root for the host bundle so DSH can discover its Web client", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
      dsh: { client: { platform?: string; inject?: string[] } };
    };
    expect(manifest.exports["."]).toEqual({
      types: "./dist/dsh.d.ts",
      default: "./dist/dsh.js",
    });
    expect(manifest.exports["./client"]).toEqual({
      types: "./dist/client.d.cts",
      default: "./dist/client.js",
    });
    expect(manifest.dsh.client).toMatchObject({ platform: "web" });
    expect(manifest.dsh.client.inject).toEqual([
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-ui-renderer",
      "@deepseek-ai/dsh-client-ui-settings",
      "@deepseek-ai/dsh-client-ui-settings-plugins",
      "@deepseek-ai/dsh-client-ui-slots",
    ]);
  });

  it("uses one shared DSH contract family without the retired client Runtime", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    for (const dependencies of [
      manifest.devDependencies,
      manifest.peerDependencies,
    ]) {
      expect(dependencies["@deepseek-ai/dsh-client-runtime"]).toBeUndefined();
      const nonCatalog = Object.entries(dependencies).filter(
        ([name, version]) =>
          name.startsWith("@deepseek-ai/dsh-") && version !== "catalog:",
      );
      expect(nonCatalog).toEqual([]);
    }
  });
});
