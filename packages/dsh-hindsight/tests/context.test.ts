import { describe, expect, it } from "vitest";

import { renderCurrentTimeContext } from "../src/context.js";

describe("current time context", () => {
  it("includes the explicit local time zone with a fixed instant", () => {
    const context = renderCurrentTimeContext(new Date("2026-08-29T02:17:56.000Z"), "Asia/Taipei");

    expect(context).toContain("Asia/Taipei");
    expect(context).toContain("GMT+08:00");
    expect(context).toContain("2026");
  });
});
