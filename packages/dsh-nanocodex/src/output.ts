import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  admitPromptContent,
  type ImageMediaType,
  type PromptContentPart,
} from "@deepseek-ai/dsh-attachment";
import {
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
  type ToolCallBlock,
} from "@deepseek-ai/dsh-llm";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
import type { AgentEvent } from "nanocodex/node";
import { APPLY_PATCH_NAME } from "./constants.js";
import { closeInterruptedToolCalls } from "./interrupted-tools.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

type RawTokenUsage = Readonly<{
  inputTokens: unknown;
  outputTokens: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
}>;

/** Normalize cache-inclusive provider usage into disjoint DSH buckets. */
export function normalizeTokenUsage(
  value: RawTokenUsage,
): TokenUsage | undefined {
  const input = count(value.inputTokens);
  const output = count(value.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheReadTokens = count(value.cacheReadTokens);
  const cacheWriteTokens = count(value.cacheWriteTokens);
  const reasoningTokens = count(value.reasoningTokens);
  const totalTokens = count(value.totalTokens);
  return {
    inputTokens: Math.max(
      0,
      input - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0),
    ),
    outputTokens: output,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** Responses input includes cache buckets; DSH input excludes them. */
export function modelCallUsage(event: AgentEvent): TokenUsage | undefined {
  if (event.type !== "model.call.completed") return undefined;
  const value = record(event.payload.usage);
  const details = record(value?.input_tokens_details);
  return normalizeTokenUsage({
    inputTokens: value?.input_tokens,
    outputTokens: value?.output_tokens,
    totalTokens: value?.total_tokens,
    cacheReadTokens: details?.cached_tokens,
    cacheWriteTokens: details?.cache_write_tokens,
    reasoningTokens: record(value?.output_tokens_details)?.reasoning_tokens,
  });
}

function outputBlock(item: Record<string, unknown>): ContentBlock | undefined {
  if (
    item.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content)
  ) {
    const text = item.content
      .map(record)
      .flatMap((part) =>
        part?.type === "output_text" && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("");
    return text ? { type: "text", text } : undefined;
  }
  if (
    (item.type === "custom_tool_call" || item.type === "function_call") &&
    typeof item.call_id === "string" &&
    typeof item.name === "string"
  ) {
    let args: string;
    if (item.type === "custom_tool_call") {
      if (typeof item.input !== "string")
        throw new Error("Nanocodex custom call has no raw input");
      if (item.name === "exec") args = JSON.stringify({ code: item.input });
      else if (item.name === APPLY_PATCH_NAME)
        args = JSON.stringify({ patch: item.input });
      else
        throw new Error(
          `Nanocodex cannot project custom tool ${JSON.stringify(item.name)}`,
        );
    } else {
      if (typeof item.arguments !== "string")
        throw new Error("Nanocodex function call has no arguments");
      args = item.arguments;
    }
    return {
      type: "tool-call",
      id: ToolCallId(item.call_id),
      name: item.name,
      arguments: args,
    };
  }
  return undefined;
}

async function resultContent(
  agent: Agent,
  value: unknown,
): Promise<ContentBlock[]> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value))
    throw new Error("Nanocodex tool result has no supported output body");
  const content: PromptContentPart[] = value.map((value) => {
    const part = record(value);
    if (part?.type === "input_text" && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      const match =
        /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/u.exec(
          part.image_url,
        );
      if (match)
        return {
          type: "image",
          mediaType: match[1] as ImageMediaType,
          data: match[2]!,
        };
    }
    throw new Error(
      "Nanocodex tool result contains an unsupported content part",
    );
  });
  if (content.every((part) => part.type === "text")) return content;
  return admitPromptContent(agent.ctx.attachments, content);
}

interface ParentCall {
  readonly block: ToolCallBlock;
  readonly step: number;
  callSeq?: SessionSeq;
}

/** One DSH step and one durable Assistant per Nanocodex model request. */
export class NanocodexOutput {
  private step: number;
  private started = false;
  private committed = false;
  private blocks: ContentBlock[] = [];
  private chunkSeqs: SessionSeq[] = [];
  private readonly textIndices = new Map<string, number>();
  private openText: number | undefined;
  private readonly outputItems = new Map<string, Record<string, unknown>>();
  private readonly parents = new Map<string, ParentCall>();

  constructor(
    private readonly agent: Agent,
    private readonly provider: string,
    private readonly model: string,
    private readonly turn: number,
    step: number,
    private readonly advanceStep: () => number,
  ) {
    this.step = step;
  }

  get coordinates(): { turn: number; step: number } {
    return { turn: this.turn, step: this.step };
  }

  private chunk(chunk: StreamChunk): void {
    this.chunkSeqs.push(
      this.agent.session.append("assistant/chunk", {
        ...this.coordinates,
        chunk,
      }).seq,
    );
  }

  private text(text: string, id: unknown, complete: boolean): void {
    if (!text) return;
    let index =
      typeof id === "string" ? this.textIndices.get(id) : this.openText;
    if (index === undefined) {
      index = this.blocks.length;
      this.blocks.push({ type: "text", text: "" });
      if (typeof id === "string") this.textIndices.set(id, index);
      this.chunk({ type: "block-start", index, blockType: "text" });
    }
    const previous = this.blocks[index];
    if (previous?.type !== "text")
      throw new Error("Nanocodex text stream lost its block");
    if (complete) {
      this.blocks[index] = { type: "text", text };
      this.chunk({ type: "block-end", index, block: this.blocks[index] });
      this.openText = undefined;
    } else {
      this.blocks[index] = { type: "text", text: previous.text + text };
      this.openText = index;
      this.chunk({ type: "text-delta", index, text });
    }
  }

  private installOutput(items: readonly Record<string, unknown>[]): void {
    this.blocks = items.flatMap((item) => {
      const block = outputBlock(item);
      return block === undefined ? [] : [block];
    });
    // The completed response is authoritative, including providers that omit
    // deltas or output_item.done. End chunks also correct streamed block order.
    for (const [index, block] of this.blocks.entries()) {
      this.chunk({ type: "block-end", index, block });
    }
  }

  private commit(usage?: TokenUsage, interrupted = false): void {
    if (this.committed) return;
    if (usage !== undefined) this.chunk({ type: "usage", usage });
    for (const block of this.blocks) {
      if (block.type === "tool-call")
        this.parents.set(String(block.id), { block, step: this.step });
    }
    this.agent.session.append(
      "assistant/message",
      {
        ...this.coordinates,
        message: createAssistantMessage({
          content: this.blocks,
          source: { provider: this.provider, model: this.model },
        }),
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted ? { interrupted: true as const } : {}),
      },
      { surfaceOp: "append", sourceEventSeqs: this.chunkSeqs },
    );
    this.committed = true;
  }

  async accept(event: AgentEvent): Promise<void> {
    const payload = event.payload;
    if (event.type === "model.call.started") {
      if (this.started) {
        if (!this.committed && this.blocks.length > 0)
          this.commit(undefined, true);
        this.step = this.advanceStep();
      }
      this.started = true;
      this.committed = false;
      this.blocks = [];
      this.chunkSeqs = [];
      this.textIndices.clear();
      this.outputItems.clear();
      this.openText = undefined;
    } else if (
      event.type === "assistant.delta" &&
      typeof payload.text === "string"
    ) {
      this.text(payload.text, payload.item_id, false);
    } else if (
      event.type === "assistant.message" &&
      typeof payload.text === "string"
    ) {
      this.text(payload.text, payload.item_id, true);
    } else if (event.type === "api.event" && payload.phase === "generation") {
      const api = record(payload.event);
      if (api?.type === "response.output_item.done") {
        const item = record(api.item);
        if (item !== undefined)
          this.outputItems.set(String(item.id ?? api.output_index), item);
      } else if (api?.type === "response.completed") {
        const output = record(api.response)?.output;
        if (Array.isArray(output) && output.length > 0)
          this.installOutput(
            output.flatMap((value) => {
              const item = record(value);
              return item === undefined ? [] : [item];
            }),
          );
        else if (this.outputItems.size > 0)
          this.installOutput([...this.outputItems.values()]);
      }
    } else if (event.type === "model.call.completed") {
      this.commit(modelCallUsage(event));
    } else if (event.type === "tool.call" || event.type === "tool.result") {
      if (typeof payload.call_id !== "string") return;
      const parent = this.parents.get(payload.call_id);
      if (
        parent === undefined ||
        (parent.block.name !== "exec" && parent.block.name !== "wait")
      )
        return;
      if (event.type === "tool.call") {
        parent.callSeq = this.agent.session.append("tool/call", {
          turn: this.turn,
          step: parent.step,
          callId: parent.block.id,
          name: parent.block.name,
          arguments: parent.block.arguments,
        }).seq;
      } else {
        if (parent.callSeq === undefined)
          throw new Error("Nanocodex parent result has no durable call");
        this.agent.session.append(
          "tool/result",
          {
            turn: this.turn,
            step: parent.step,
            message: createToolResultMessage({
              callId: parent.block.id,
              content: await resultContent(this.agent, payload.result),
              isError: payload.status !== "completed",
            }),
          },
          { surfaceOp: "append", sourceEventSeqs: [parent.callSeq] },
        );
        this.parents.delete(payload.call_id);
      }
    }
  }

  finish(finalText: string): void {
    if (this.committed) return;
    if (this.blocks.length === 0 && finalText)
      this.text(finalText, undefined, true);
    if (this.blocks.length > 0) this.commit();
  }

  interrupt(error: unknown): void {
    if (!this.committed && this.blocks.length > 0) this.commit(undefined, true);
    closeInterruptedToolCalls(this.agent.session, error);
  }
}
