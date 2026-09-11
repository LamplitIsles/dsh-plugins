import type { Agent } from "@deepseek-ai/dsh-agent";
import { ToolCallId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionSeq } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import type {
  ToolDefinition,
  ToolExecutionResult,
  ToolRuntime,
} from "@deepseek-ai/dsh-tools";
import type {
  NamedTool,
  ToolContext,
  ToolDefinition as NanocodexToolDefinition,
} from "nanocodex/node";
import { APPLY_PATCH_NAME } from "./constants.js";

export interface ToolBridgeCallbacks {
  onCall(call: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
    readonly parentCallId?: string;
  }): SessionSeq | undefined | Promise<SessionSeq | undefined>;
  onResult(call: {
    readonly id: string;
    readonly callSeq: SessionSeq | undefined;
    readonly result: ToolExecutionResult;
    readonly parentCallId?: string;
  }): void | Promise<void>;
}

export interface ToolBridgeContext {
  readonly tools: ToolRuntime;
  readonly agent: Agent;
  readonly callbacks: ToolBridgeCallbacks;
  readonly signal: AbortSignal;
  /** Provider-native definitions for tools whose wire input is not JSON. */
  readonly customDefinitions?: ReadonlyMap<string, NanocodexToolDefinition>;
}

function jsonArguments(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch (error) {
    throw new Error("Nanocodex produced non-serializable tool arguments", {
      cause: error,
    });
  }
}

function normalizedArguments(input: unknown): {
  readonly text: string;
  readonly value: unknown;
} {
  const text = jsonArguments(input);
  return { text, value: JSON.parse(text) as unknown };
}

function contentText(content: readonly ContentBlock[]): string {
  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return text || "The DSH tool returned no text content.";
}

function modelValue(result: ToolExecutionResult, custom: boolean): unknown {
  if (custom) return contentText(result.content);
  if (!result.isError) return result.value;
  return {
    error: result.error.message,
    content: contentText(result.content),
  };
}

function executionFailure(error: unknown): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    error: { message },
    content: [{ type: "text", text: message }],
  };
}

function makeTool(
  definition: ToolDefinition,
  context: ToolBridgeContext,
  customDefinition: NanocodexToolDefinition | undefined,
): NamedTool {
  const custom = customDefinition?.type === "custom";
  return {
    name: definition.name,
    description: definition.description,
    parameters: structuredClone(definition.parameters),
    outputSchema: structuredClone(definition.output.schema) as Record<
      string,
      unknown
    >,
    ...(customDefinition === undefined
      ? {}
      : { definition: structuredClone(customDefinition) }),
    async handler(input: unknown, call: ToolContext): Promise<unknown> {
      const id = call.callId;
      const canonicalInput =
        custom && definition.name === APPLY_PATCH_NAME
          ? (() => {
              if (typeof input !== "string" || input.length === 0) {
                throw new TypeError(
                  "apply_patch expects one non-empty raw patch string",
                );
              }
              return { patch: input };
            })()
          : input;
      const argumentsValue = normalizedArguments(canonicalInput);
      const callSeq = await context.callbacks.onCall({
        id,
        name: definition.name,
        arguments: argumentsValue.text,
        ...(call.parentCallId ? { parentCallId: call.parentCallId } : {}),
      });
      const parentCallId = call.parentCallId;
      if (parentCallId) {
        context.agent.session.append("tool/code-dispatch-start", {
          rootCallId: ToolCallId(parentCallId),
          parentCallId: ToolCallId(parentCallId),
          subCallId: ToolCallId(id),
          name: definition.name,
          arguments: argumentsValue.value,
        });
      }
      let result: ToolExecutionResult;
      try {
        result = await context.tools.execute({
          callId: ToolCallId(id),
          ...(call.parentCallId
            ? { rootCallId: ToolCallId(call.parentCallId) }
            : {}),
          name: definition.name,
          arguments: argumentsValue.value,
          agent: context.agent,
          signal: call.signal,
        });
      } catch (error) {
        // ToolRuntime normally materializes pipeline failures itself. Keep the
        // DSH tool/result pair balanced if a host implementation violates that
        // promise or a listener throws across the service boundary.
        result = executionFailure(error);
      }
      try {
        await context.callbacks.onResult({
          id,
          callSeq,
          result,
          ...(parentCallId ? { parentCallId } : {}),
        });
      } finally {
        if (parentCallId) {
          context.agent.session.append("tool/code-dispatch", {
            rootCallId: ToolCallId(parentCallId),
            parentCallId: ToolCallId(parentCallId),
            subCallId: ToolCallId(id),
            name: definition.name,
            arguments: argumentsValue.value,
            isError: result.isError,
            content: result.content,
          });
        }
      }
      return modelValue(result, custom);
    },
  };
}

/** Build one model-facing tool set from the active DSH scope. */
export function createToolBridge(context: ToolBridgeContext): NamedTool[] {
  const scope = scopeOf(context.agent.ctx);
  return context.tools
    .schemas(scope)
    .map((schema) => context.tools.get(schema.name, scope))
    .filter(
      (definition): definition is ToolDefinition => definition !== undefined,
    )
    .map((definition) =>
      makeTool(
        definition,
        context,
        context.customDefinitions?.get(definition.name),
      ),
    );
}

export type ToolBridge = ReturnType<typeof createToolBridge>;
