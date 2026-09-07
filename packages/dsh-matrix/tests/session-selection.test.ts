import { describe, expect, it } from "vitest";
import { selectMostRecentEligibleSession } from "../src/session-selection.js";

const userEvent = (time: number) => ({
  type: "user/message",
  time,
  data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "prompt" }] }
});

describe("session selection", () => {
  it("uses authoritative workspace membership and deterministic activity tie breaks", () => {
    const workspace = { id: "w", sessionIds: ["blank", "archived", "child", "older", "newer", "tie-b"] };
    const inspections = new Map([
      ["blank", { meta: { id: "blank" }, events: [] }],
      ["archived", { meta: { id: "archived" }, events: [userEvent(100)] }],
      ["child", { meta: { id: "child", origin: "subagent" }, events: [userEvent(999)] }],
      ["older", { meta: { id: "older" }, events: [userEvent(100)] }],
      ["newer", { meta: { id: "newer" }, events: [userEvent(200)] }],
      ["tie-b", { meta: { id: "tie-b" }, events: [userEvent(200)] }]
    ]);
    expect(selectMostRecentEligibleSession(workspace, inspections, new Set(["archived"]))).toMatchObject({ sessionId: "newer" });
  });

  it("returns no candidate when every member is blank, archived, or a subagent", () => {
    const workspace = { id: "w", sessionIds: ["blank", "child"] };
    const inspections = new Map([
      ["blank", { meta: { id: "blank" }, events: [] }],
      ["child", { meta: { id: "child", origin: "subagent" }, events: [userEvent(1)] }]
    ]);
    expect(selectMostRecentEligibleSession(workspace, inspections, new Set())).toBeUndefined();
  });
});
