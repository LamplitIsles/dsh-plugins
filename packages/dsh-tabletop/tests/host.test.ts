import { Context } from "@deepseek-ai/cordis";
import Tools, {
  type ToolRunContext,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import { expect, it } from "vitest";
import * as tabletop from "../src/index.js";

it("registers one tool, returns and renders canonical rolls, and unregisters on unload", async () => {
  const root = new Context();
  root.provide("systemPrompt", { tools: () => () => undefined });
  const runtime = root.plugin(Tools);
  await runtime;
  const fiber = root.plugin(tabletop);
  await fiber;
  try {
    expect(root.tools.schemas().map((tool) => tool.name)).toEqual([
      "roll_dice",
    ]);
    const tool = root.tools.get("roll_dice")!;
    expect(tool.parameters.additionalProperties).toBe(false);
    const exec = { signal: new AbortController().signal } as ToolRunContext;
    const args = { count: 3, sides: 6, modifier: -2, label: "attack" };
    const result = (await tool.execute(args, exec)) as {
      count: number;
      sides: number;
      rolls: number[];
      modifier: number;
      total: number;
      label: string;
    };
    expect(validateJsonSchemaValue(tool.output.schema, result)).toEqual([]);
    expect(result).toEqual({
      ...args,
      rolls: result.rolls,
      total: result.rolls.reduce((sum, die) => sum + die, -2),
    });
    expect(result.rolls).toHaveLength(3);
    expect(
      result.rolls.every(
        (die) => Number.isInteger(die) && die >= 1 && die <= 6,
      ),
    ).toBe(true);
    const content = [{ type: "text", text: JSON.stringify(result) }];
    expect(tool.output.render(args, result)).toEqual(content);
    expect(tool.output.render(args, result)).toEqual(content);
    const defaults = await tool.execute({ sides: 6 }, exec);
    expect(defaults).toMatchObject({ count: 1, sides: 6, modifier: 0 });
    expect(defaults).not.toHaveProperty("label");
    for (const invalid of [
      { sides: 6.5 },
      { sides: 1 },
      { sides: 6, count: 101 },
      { sides: 6, extra: true },
      { sides: 6, label: "x".repeat(201) },
    ]) {
      await expect(tool.execute(invalid, exec)).rejects.toThrow(
        /must be|Only count|Provide/,
      );
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute({ sides: 6 }, {
        signal: controller.signal,
      } as ToolRunContext),
    ).rejects.toThrow(/aborted/i);
    await fiber.dispose();
    expect(root.tools.schemas()).toEqual([]);
  } finally {
    await fiber.dispose();
    await runtime.dispose();
  }
});
