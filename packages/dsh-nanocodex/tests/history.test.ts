import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import {
  compactCheckpointSource,
  CompactionId,
} from "@deepseek-ai/dsh-compaction";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import {
  buildHistoryProjection,
  buildHistorySeed,
  buildPromptInput,
} from "../src/history.js";

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId("sha256:fixture-image"),
  mediaType: "image/png",
  bytes: 3,
  width: 1,
  height: 1,
};

function attachments(): AttachmentStore {
  return {
    readImage: async (ref: ImageAttachmentRef) => ({
      ref,
      data: new Uint8Array([1, 2, 3]),
    }),
  } as unknown as AttachmentStore;
}

describe("Nanocodex history projection", () => {
  it("hydrates active text, image, tool call, and tool result without execution", async () => {
    const callId = ToolCallId("call-1");
    const messages = [
      createUserMessage({
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", attachment: imageRef },
        ],
        source: { kind: "user" },
      }),
      createAssistantMessage({
        content: [
          { type: "tool-call", id: callId, name: "roll_dice", arguments: "{}" },
        ],
        source: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      createToolResultMessage({
        callId,
        content: [{ type: "text", text: '{"total":4}' }],
        isError: false,
      }),
    ];

    const seed = await buildHistorySeed(messages, {
      attachments: attachments(),
    });
    expect(seed.continuitySummary).toBeUndefined();
    expect(seed.history).toMatchObject([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Look at this" },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
        ],
      },
      {
        type: "function_call",
        name: "roll_dice",
        arguments: "{}",
        call_id: "call-1",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: '{"total":4}',
      },
    ]);
  });

  it("keeps the active compaction checkpoint private to continuitySummary", async () => {
    const checkpoint = createUserMessage({
      content: [
        { type: "text", text: "## Shared Facts\n- The user likes tea." },
      ],
      source: compactCheckpointSource(CompactionId("compact-1")),
    });
    const seed = await buildHistorySeed(
      [
        checkpoint,
        createUserMessage({
          content: [{ type: "text", text: "Continue" }],
          source: { kind: "user" },
        }),
      ],
      { attachments: attachments() },
    );
    expect(seed.continuitySummary).toContain("The user likes tea");
    expect(seed.history).toHaveLength(1);
    expect(seed.history[0]).toMatchObject({ role: "user" });
  });

  it("hydrates apply_patch as a raw custom call without executing it", async () => {
    const patchCallId = ToolCallId("patch-call");
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: "tool-call",
            id: patchCallId,
            name: "apply_patch",
            arguments: JSON.stringify({
              patch: "*** Begin Patch\n*** End Patch\n",
            }),
          },
        ],
        source: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      createToolResultMessage({
        callId: patchCallId,
        content: [{ type: "text", text: "Applied 1 file." }],
        isError: false,
      }),
    ];

    const projection = await buildHistoryProjection(messages, {
      attachments: attachments(),
    });
    expect(projection.history).toEqual([
      {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch\n",
        call_id: "patch-call",
      },
      {
        type: "custom_tool_call_output",
        name: "apply_patch",
        call_id: "patch-call",
        output: "Applied 1 file.",
      },
    ]);
    expect(projection.items.map(({ message }) => message.id)).toEqual(
      messages.map((message) => message.id),
    );
  });

  it("accepts parallel patch calls with results in completion order", async () => {
    const patch = (name: string) =>
      JSON.stringify({
        patch: `*** Begin Patch\n*** ${name}\n*** End Patch\n`,
      });
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: "tool-call" as const,
            id: ToolCallId("patch-a"),
            name: "apply_patch",
            arguments: patch("Add File: a.txt"),
          },
          {
            type: "tool-call" as const,
            id: ToolCallId("patch-b"),
            name: "apply_patch",
            arguments: patch("Add File: b.txt"),
          },
        ],
        source: { provider: "openai", model: "gpt-5.6-sol" },
      }),
      createToolResultMessage({
        callId: ToolCallId("patch-b"),
        content: [{ type: "text", text: "Applied b." }],
        isError: false,
      }),
      createToolResultMessage({
        callId: ToolCallId("patch-a"),
        content: [{ type: "text", text: "Applied a." }],
        isError: false,
      }),
    ];

    const seed = await buildHistorySeed(messages, {
      attachments: attachments(),
    });
    expect(
      seed.history.map((item) =>
        "call_id" in item ? `${item.type}:${item.call_id}` : item.type,
      ),
    ).toEqual([
      "custom_tool_call:patch-a",
      "custom_tool_call:patch-b",
      "custom_tool_call_output:patch-b",
      "custom_tool_call_output:patch-a",
    ]);
  });

  it("rejects incomplete or mismatched apply_patch histories", async () => {
    const patchCall = (id: string) =>
      createAssistantMessage({
        content: [
          {
            type: "tool-call" as const,
            id: ToolCallId(id),
            name: "apply_patch",
            arguments: JSON.stringify({
              patch: "*** Begin Patch\n*** End Patch\n",
            }),
          },
        ],
        source: { provider: "openai", model: "gpt-5.6-sol" },
      });
    const patchResult = (id: string) =>
      createToolResultMessage({
        callId: ToolCallId(id),
        content: [{ type: "text", text: "Applied." }],
        isError: false,
      });
    const cases = [
      {
        name: "dangling call",
        messages: [patchCall("patch-a")],
      },
      {
        name: "output before call",
        messages: [patchResult("patch-a"), patchCall("patch-a")],
      },
      {
        name: "foreign output",
        messages: [patchCall("patch-a"), patchResult("foreign")],
      },
      {
        name: "duplicate call",
        messages: [
          patchCall("patch-a"),
          patchCall("patch-a"),
          patchResult("patch-a"),
        ],
      },
      {
        name: "duplicate output",
        messages: [
          patchCall("patch-a"),
          patchResult("patch-a"),
          patchResult("patch-a"),
        ],
      },
    ];

    for (const testCase of cases) {
      await expect(
        buildHistorySeed(testCase.messages, { attachments: attachments() }),
      ).rejects.toThrow(/Nanocodex cannot hydrate/iu);
    }
  });

  it("does not duplicate injected context into the ordinary prompt helper", async () => {
    const user = createUserMessage({
      content: [{ type: "text", text: "Answer me" }],
      source: { kind: "user" },
    });
    const injected = createUserMessage({
      content: [{ type: "text", text: "Recall: user likes tea" }],
      source: { kind: "plugin", plugin: "hindsight" },
    });
    const prompt = await buildPromptInput([user], {
      attachments: attachments(),
    });
    expect(prompt).toBe("Answer me");
    expect(injected.content[0]).toMatchObject({ type: "text" });
  });

  it("rejects retained reasoning blocks instead of silently changing context", async () => {
    const message = createAssistantMessage({
      content: [{ type: "reasoning", text: "private reasoning" }],
      source: { provider: "openai", model: "gpt-5.6-sol" },
    });
    await expect(
      buildHistorySeed([message], { attachments: attachments() }),
    ).rejects.toThrow(/cannot hydrate assistant content block.*reasoning/iu);
  });
});
