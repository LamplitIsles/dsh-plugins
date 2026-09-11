import type {
  AttachmentStore,
  ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import type { ContentBlock, Message, ToolCallId } from "@deepseek-ai/dsh-llm";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import type {
  HistoryContentItem,
  HistoryItem,
  HistorySeed,
} from "nanocodex/node";
import { APPLY_PATCH_NAME } from "./constants.js";

type HistoryToolOutput =
  | string
  | readonly (
      | { type: "input_text"; text: string }
      | {
          type: "input_image";
          image_url: string;
          detail?: "auto" | "low" | "high" | "original" | undefined;
        }
      | { type: "input_audio"; audio_url: string }
      | { type: "encrypted_content"; encrypted_content: string }
    )[];

type HistoryToolOutputItem = Exclude<HistoryToolOutput, string>[number];

export interface HistoryContext {
  readonly attachments: AttachmentStore;
}

function imageDataUrl(ref: ImageAttachmentRef, bytes: Uint8Array): string {
  return `data:${ref.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function imageItem(
  ctx: HistoryContext,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<Extract<HistoryContentItem, { type: "input_image" }>> {
  const stored = await ctx.attachments.readImage(ref, signal);
  return {
    type: "input_image",
    image_url: imageDataUrl(stored.ref, stored.data),
    detail: "auto",
  };
}

function outputText(
  block: ContentBlock,
): Extract<HistoryContentItem, { type: "output_text" }> {
  if (block.type !== "text") {
    throw new Error(
      `Nanocodex cannot hydrate assistant content block ${JSON.stringify(block.type)}`,
    );
  }
  return { type: "output_text", text: block.text };
}

function inputText(
  block: ContentBlock,
): Extract<HistoryContentItem, { type: "input_text" }> {
  if (block.type !== "text") {
    throw new Error(
      `Nanocodex cannot hydrate user content block ${JSON.stringify(block.type)}`,
    );
  }
  return { type: "input_text", text: block.text };
}

async function toolOutput(
  ctx: HistoryContext,
  blocks: readonly ContentBlock[],
  signal?: AbortSignal,
): Promise<HistoryToolOutput> {
  if (blocks.length === 1 && blocks[0]?.type === "text") return blocks[0].text;
  const output: HistoryToolOutputItem[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      if (block.type === "image") {
        output.push(await imageItem(ctx, block.attachment, signal));
        continue;
      }
      throw new Error(
        `Nanocodex cannot hydrate tool-result content block ${JSON.stringify(block.type)}`,
      );
    }
    output.push({ type: "input_text", text: block.text });
  }
  return output;
}

function textOfCheckpoint(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type !== "text") {
        throw new Error(
          `Nanocodex cannot hydrate compaction checkpoint block ${JSON.stringify(block.type)}`,
        );
      }
      return block.text;
    })
    .join("\n");
}

function callId(value: ToolCallId): string {
  return String(value);
}

function rawApplyPatch(argumentsText: string): string {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
  } catch (error) {
    throw new Error("Nanocodex cannot hydrate an invalid apply_patch call", {
      cause: error,
    });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { patch?: unknown }).patch !== "string" ||
    Object.keys(value).length !== 1
  ) {
    throw new Error(
      "Nanocodex cannot hydrate apply_patch without canonical {patch} arguments",
    );
  }
  return (value as { patch: string }).patch;
}

function validateToolPairs(
  messages: readonly Message[],
): ReadonlyMap<string, string> {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "tool-call") continue;
      const id = callId(block.id);
      if (toolNames.has(id)) {
        throw new Error(
          `Nanocodex cannot hydrate duplicate tool call ${JSON.stringify(id)}`,
        );
      }
      toolNames.set(id, block.name);
    }
  }

  const seenCalls = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === "assistant" && block.type === "tool-call") {
        seenCalls.add(callId(block.id));
        continue;
      }
      if (block.type !== "tool-result") continue;
      const id = callId(block.toolCallId);
      const name = toolNames.get(id);
      if (name === undefined) {
        throw new Error(
          `Nanocodex cannot hydrate a tool result for foreign call ${JSON.stringify(id)}`,
        );
      }
      if (name !== APPLY_PATCH_NAME) continue;
      if (!seenCalls.has(id)) {
        throw new Error(
          `Nanocodex cannot hydrate apply_patch output before call ${JSON.stringify(id)}`,
        );
      }
      if (resultIds.has(id)) {
        throw new Error(
          `Nanocodex cannot hydrate duplicate apply_patch output ${JSON.stringify(id)}`,
        );
      }
      resultIds.add(id);
    }
  }

  for (const [id, name] of toolNames) {
    if (name === APPLY_PATCH_NAME && !resultIds.has(id)) {
      throw new Error(
        `Nanocodex cannot hydrate apply_patch call without a result ${JSON.stringify(id)}`,
      );
    }
  }
  return toolNames;
}

export interface HistoryProjectionItem {
  readonly message: Message;
  readonly item: HistoryItem;
}

export interface HistoryProjection extends HistorySeed {
  readonly items: readonly HistoryProjectionItem[];
}

/**
 * Convert the authoritative active DSH surface to Nanocodex's typed history.
 * Tool calls are represented as history items only; no handler is invoked while
 * hydrating a session.
 */
export async function buildHistoryProjection(
  messages: readonly Message[],
  ctx: HistoryContext,
  signal?: AbortSignal,
): Promise<HistoryProjection> {
  const history: HistoryItem[] = [];
  const items: HistoryProjectionItem[] = [];
  let continuitySummary: string | undefined;
  const toolNames = validateToolPairs(messages);
  const push = (message: Message, item: HistoryItem): void => {
    history.push(item);
    items.push({ message, item });
  };

  for (const message of messages) {
    signal?.throwIfAborted();
    if (message.role === "user" && isCompactCheckpointSource(message.source)) {
      continuitySummary = textOfCheckpoint(message);
      continue;
    }

    const toolResult = message.content[0];
    if (
      message.role === "user" &&
      message.content.length === 1 &&
      toolResult?.type === "tool-result"
    ) {
      const id = callId(toolResult.toolCallId);
      const name = toolNames.get(id);
      const output = await toolOutput(ctx, toolResult.content, signal);
      push(
        message,
        name === APPLY_PATCH_NAME
          ? { type: "custom_tool_call_output", name, call_id: id, output }
          : { type: "function_call_output", call_id: id, output },
      );
      continue;
    }

    if (message.role === "assistant") {
      const output: HistoryContentItem[] = [];
      for (const block of message.content) {
        if (block.type === "tool-call") {
          if (output.length > 0) {
            push(message, {
              type: "message",
              role: "assistant",
              content: output.splice(0),
              id: String(message.id),
              status: "completed",
            });
          }
          const id = callId(block.id);
          if (block.name === APPLY_PATCH_NAME) {
            push(message, {
              type: "custom_tool_call",
              name: block.name,
              input: rawApplyPatch(block.arguments),
              call_id: id,
            });
          } else {
            push(message, {
              type: "function_call",
              name: block.name,
              arguments: block.arguments,
              call_id: id,
            });
          }
          continue;
        }
        output.push(outputText(block));
      }
      if (output.length > 0) {
        push(message, {
          type: "message",
          role: "assistant",
          content: output,
          id: String(message.id),
          status: "completed",
        });
      }
      continue;
    }

    const content: HistoryContentItem[] = [];
    for (const block of message.content) {
      if (block.type === "image") {
        content.push(await imageItem(ctx, block.attachment, signal));
      } else if (block.type === "text") {
        content.push(inputText(block));
      } else {
        throw new Error(
          `Nanocodex cannot hydrate user content block ${JSON.stringify(block.type)}`,
        );
      }
    }
    if (content.length === 0) {
      throw new Error(
        `Nanocodex cannot hydrate empty DSH message ${String(message.id)}`,
      );
    }
    push(message, {
      type: "message",
      role: message.role === "system" ? "developer" : "user",
      content,
      id: String(message.id),
      status: "completed",
    });
  }

  return {
    history,
    items,
    ...(continuitySummary !== undefined ? { continuitySummary } : {}),
  };
}

export async function buildHistorySeed(
  messages: readonly Message[],
  ctx: HistoryContext,
  signal?: AbortSignal,
): Promise<HistorySeed> {
  const { items: _items, ...seed } = await buildHistoryProjection(
    messages,
    ctx,
    signal,
  );
  return seed;
}

export interface PromptInputContext {
  readonly attachments: AttachmentStore;
}

export type NanocodexPromptItem =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly image_url: string;
      readonly detail: "auto";
    };

/** Convert newly admitted DSH user content into one Nanocodex prompt. */
export async function buildPromptInput(
  messages: readonly Message[],
  ctx: PromptInputContext,
  signal?: AbortSignal,
): Promise<string | readonly NanocodexPromptItem[]> {
  const items: NanocodexPromptItem[] = [];
  for (const message of messages) {
    signal?.throwIfAborted();
    for (const block of message.content) {
      if (block.type === "text") items.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        const stored = await ctx.attachments.readImage(
          block.attachment,
          signal,
        );
        items.push({
          type: "image",
          image_url: imageDataUrl(stored.ref, stored.data),
          detail: "auto",
        });
      } else if (block.type === "tool-result") {
        // Tool results already belong to the seeded history. They are not a
        // second user prompt for the next Nanocodex turn.
        continue;
      } else {
        throw new Error(
          `Nanocodex cannot use admitted DSH content block ${JSON.stringify(block.type)} as prompt input`,
        );
      }
    }
  }
  if (items.length === 0) return "Continue from the current conversation.";
  if (items.length === 1 && items[0]?.type === "text") return items[0].text;
  return items;
}

export function plainText(messages: readonly Message[]): string {
  return messages
    .flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      ),
    )
    .join("\n");
}
