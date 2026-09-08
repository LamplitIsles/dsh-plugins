import { describe, expect, it, vi } from "vitest";
import { rollDice } from "../src/core.js";

describe("rollDice", () => {
  it("defaults count and modifier and omits an absent label", () => {
    const draw = vi.fn(() => 6);
    expect(rollDice({ sides: 6 }, draw)).toEqual({
      count: 1,
      sides: 6,
      rolls: [6],
      modifier: 0,
      total: 6,
    });
    expect(draw.mock.calls).toEqual([[1, 7]]);
  });

  it.each([4, -4, 0])(
    "adds modifier %s once and preserves the label",
    (modifier) => {
      const draw = vi
        .fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(20)
        .mockReturnValueOnce(7);
      expect(
        rollDice(
          { count: 3, sides: 20, modifier, label: "  Initiative 🎲  " },
          draw,
        ),
      ).toEqual({
        count: 3,
        sides: 20,
        rolls: [1, 20, 7],
        modifier,
        total: 28 + modifier,
        label: "  Initiative 🎲  ",
      });
      expect(draw.mock.calls).toEqual([
        [1, 21],
        [1, 21],
        [1, 21],
      ]);
    },
  );

  it("accepts the upper bounds and keeps the total a safe integer", () => {
    const draw = vi.fn((_min: number, max: number) => max - 1);
    const result = rollDice(
      {
        count: 100,
        sides: 1_000_000,
        modifier: 1_000_000,
        label: "x".repeat(200),
      },
      draw,
    );
    expect(result.rolls).toEqual(Array(100).fill(1_000_000));
    expect(result.total).toBe(101_000_000);
    expect(Number.isSafeInteger(result.total)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(100);
  });

  it("accepts minimum sides, minimum modifier, and an empty supplied label", () => {
    expect(
      rollDice({ sides: 2, modifier: -1_000_000, label: "" }, () => 1),
    ).toEqual({
      count: 1,
      sides: 2,
      rolls: [1],
      modifier: -1_000_000,
      total: -999_999,
      label: "",
    });
  });

  it.each([
    null,
    undefined,
    [],
    "2d6",
    {},
    { sides: 6, notation: "2d6" },
    ...["count", "sides", "modifier"].flatMap((field) =>
      [
        null,
        "6",
        true,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((value) => ({ sides: 6, [field]: value })),
    ),
    ...[0, -1, 101].map((count) => ({ sides: 6, count })),
    ...[0, 1, -1, 1_000_001].map((sides) => ({ sides })),
    ...[-1_000_001, 1_000_001].map((modifier) => ({ sides: 6, modifier })),
    ...[null, 1, {}, "x".repeat(201)].map((label) => ({ sides: 6, label })),
  ])("rejects invalid input before drawing: %j", (input) => {
    const draw = vi.fn(() => 1);
    expect(() => rollDice(input, draw)).toThrow();
    expect(draw).not.toHaveBeenCalled();
  });
});
