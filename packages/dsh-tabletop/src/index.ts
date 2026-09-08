import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  MAX_COUNT,
  MAX_LABEL_LENGTH,
  MAX_MODIFIER,
  MAX_SIDES,
  rollDice,
} from "./core.js";

export const name = "dsh-tabletop";
export const inject = ["tools"] as const;

export function apply(ctx: Context): void {
  const tool = defineTool({
    name: "roll_dice",
    description:
      "Roll dice with structured count and sides, plus an optional modifier and label. Use the returned rolls and total as the source of truth.",
    parameters: {
      count: {
        type: "integer",
        default: 1,
        description: `Number of dice, 1-${MAX_COUNT}; defaults to 1.`,
      },
      sides: {
        type: "integer",
        required: true,
        description: `Sides per die, 2-${MAX_SIDES}.`,
      },
      modifier: {
        type: "integer",
        default: 0,
        description: `Add once to the sum, -${MAX_MODIFIER} to ${MAX_MODIFIER}; defaults to 0.`,
      },
      label: {
        type: "string",
        description: `Optional label, at most ${MAX_LABEL_LENGTH} characters; preserved verbatim.`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          sides: { type: "integer", required: true },
          rolls: { type: "array", items: { type: "integer" }, required: true },
          modifier: { type: "integer", required: true },
          total: { type: "integer", required: true },
          label: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return rollDice(args);
    },
  });
  // The rc.1 parameter DSL has an open root. Close the model-facing schema;
  // the core also rejects unknown keys before drawing any dice.
  ctx.tools.register({
    ...tool,
    parameters: { ...tool.parameters, additionalProperties: false },
  });
}
