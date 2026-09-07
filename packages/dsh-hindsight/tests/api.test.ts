import { afterEach, describe, expect, it, vi } from "vitest";

import { HindsightClient } from "../src/api.js";
import { DEFAULT_RECALL } from "../src/config.js";
import { hindsightJson, hindsightRequest } from "./hindsight-request.js";

describe("HindsightClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes companion recall and retain settings through the official SDK", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = await hindsightRequest(input, init);
      requests.push(request);
      if (request.url.endsWith("/memories/recall")) {
        return hindsightJson({ results: [
          { id: "fact-low", text: "Neil prefers short replies.", type: "observation", scores: { final: 0.2 } },
          { id: "fact-1", text: "Neil prefers short Chinese replies.", type: "observation", scores: { final: 0.8 } },
          { id: "empty", text: "" }
        ] });
      }
      return hindsightJson({ operation_id: "queued" });
    });
    globalThis.fetch = fetcher;
    const client = new HindsightClient("http://memory.test", "yuki bank", "token");

    await expect(client.recall("reply style", DEFAULT_RECALL)).resolves.toEqual([
      {
        id: "fact-1",
        text: "Neil prefers short Chinese replies.",
        type: "observation",
        scores: { final: 0.8 },
        score: 0.8
      },
      {
        id: "fact-low",
        text: "Neil prefers short replies.",
        type: "observation",
        scores: { final: 0.2 },
        score: 0.2
      }
    ]);
    await client.retain("session-1", 2, [{ role: "user", content: "记住我喜欢短句" }], "replace");
    await client.retain("session-1", 3, [{ role: "user", content: "也记住这一句" }], "append");

    expect(requests[0]).toMatchObject({
      url: "http://memory.test/v1/default/banks/yuki%20bank/memories/recall",
      body: {
        query: "reply style",
        budget: "low",
        max_tokens: 900,
        prefer_observations: true
      }
    });
    const retained = requests.slice(1).map((request) => request.body.items as Array<Record<string, unknown>>);
    expect(retained.map(([item]) => item?.document_id)).toEqual([
      "dsh:session-1",
      "dsh:session-1"
    ]);
    expect(retained.map(([item]) => item?.update_mode)).toEqual(["replace", "append"]);
    expect(retained.map(([item]) => item?.content)).toEqual([
      `${JSON.stringify({ role: "user", content: "记住我喜欢短句" })}\n`,
      `${JSON.stringify({ role: "user", content: "也记住这一句" })}\n`
    ]);
    expect(retained[0]?.[0]).toMatchObject({
      // Hindsight validates every metadata value as a string.
      metadata: { turn: "2" }
    });
    expect(retained[0]?.[0]).not.toHaveProperty("context");
    expect(retained[0]?.[0]).not.toHaveProperty("strategy");
    expect(requests[1].body.operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const identicalTurn = [{ role: "user" as const, content: "这句内容在不同回合相同" }];
    await client.retain("session-identities", 7, identicalTurn, "append");
    await client.retain("session-identities", 7, identicalTurn, "append");
    await client.retain("session-identities", 8, identicalTurn, "append");
    const operationIds = requests.slice(3).map((request) => request.body.operation_id as string);

    expect(operationIds[0]).toBe(operationIds[1]);
    expect(operationIds[2]).not.toBe(operationIds[0]);
  });
});
