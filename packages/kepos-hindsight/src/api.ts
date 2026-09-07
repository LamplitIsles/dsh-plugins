import { createHash } from "node:crypto";
import { HindsightClient as HindsightSdkClient } from "@vectorize-io/hindsight-client";

import type { RecallSettings, RecalledMemory, TranscriptTurn } from "./types.js";

/** Small DSH-shaped adapter over the official typed Hindsight SDK. */
export class HindsightClient {
  private readonly client: HindsightSdkClient;

  constructor(
    apiUrl: string,
    private readonly bankId: string,
    apiToken?: string
  ) {
    this.client = new HindsightSdkClient({
      baseUrl: apiUrl,
      ...(apiToken ? { apiKey: apiToken } : {})
    });
  }

  async recall(query: string, settings: RecallSettings, signal?: AbortSignal): Promise<RecalledMemory[]> {
    const response = await this.client.recall(this.bankId, query, {
      budget: settings.budget,
      types: settings.types,
      maxTokens: settings.maxTokens,
      preferObservations: settings.preferObservations,
      signal
    });
    return response.results
      .map(toMemory)
      .filter((memory): memory is RecalledMemory => memory !== undefined)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, settings.topK);
  }

  async reflect(query: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.reflect(this.bankId, query, { budget: "low", signal });
    return response.text.trim();
  }

  /** Update one session document with a full replace or an incremental append. */
  async retain(
    sessionId: string,
    turn: number,
    turns: TranscriptTurn[],
    updateMode: "replace" | "append"
  ): Promise<void> {
    if (!turns.length) return;
    // A trailing newline keeps the stored session a valid JSONL transcript even
    // when Hindsight implements append as literal text concatenation.
    const content = `${turns.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const documentId = `dsh:${sessionId}`;
    const operationId = deterministicOperationId(`${this.bankId}\n${documentId}\n${turn}\n${updateMode}\n${content}`);
    await this.client.retain(this.bankId, content, {
      async: true,
      operationId,
      documentId,
      updateMode,
      tags: ["source:chat", "harness:dsh", "mode:companion"],
      metadata: {
        source: "chat",
        harness: "dsh",
        session_id: sessionId,
        turn: String(turn)
      }
    });
  }
}

/**
 * Hindsight expects a UUID operation ID. Keep it deterministic so retrying a
 * completed turn remains idempotent without keeping another local state file.
 */
function deterministicOperationId(value: string): string {
  const bytes = createHash("sha1").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMemory(value: unknown): RecalledMemory | undefined {
  if (!isRecord(value)) return undefined;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) return undefined;
  const scores = isRecord(value.scores) ? value.scores : undefined;
  return {
    ...value,
    text,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof scores?.final === "number" ? { score: scores.final } : {})
  };
}
