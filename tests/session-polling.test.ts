import { describe, expect, it } from "vitest";
import { waitForFinalizedAssistant } from "../packages/dsh-nanocodex/scripts/session-polling.mjs";

describe("finalized Web session polling", () => {
  it("keeps polling after provider receipt until the assistant event is durable", async () => {
    const pages = [
      { records: [] },
      { records: [{ event: { type: "turn/end" } }] },
      {
        records: [
          {
            event: {
              type: "assistant/message",
              message: { content: [{ type: "text", text: "finished" }] },
            },
          },
        ],
      },
    ];
    let calls = 0;
    const page = await waitForFinalizedAssistant({
      expectedText: "finished",
      loadPage: async () => pages[calls++] ?? pages.at(-1)!,
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(page.records).toHaveLength(1);
  });
});
