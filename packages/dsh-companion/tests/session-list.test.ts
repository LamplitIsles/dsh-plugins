import { describe, expect, it } from "vitest";
import {
  companionSessionList,
  resolveCompanionSessionSelection,
  selectCompanionSession,
} from "../src/client/relationship.js";

describe("Companion session sidebar", () => {
  it("lists only selectable sessions from the configured Workspace", () => {
    const rows = companionSessionList(
      [
        { id: "older", displayTitle: "昨晚", updatedAt: 1, running: false },
        {
          id: "human-fork",
          displayTitle: "今天的分支",
          updatedAt: 10,
          parentId: "older",
        },
        { id: "newer", displayTitle: "今天", updatedAt: 9, running: true },
        { id: "archived", displayTitle: "归档", updatedAt: 10 },
        {
          id: "child",
          displayTitle: "子代理",
          updatedAt: 11,
          origin: "subagent",
        },
        { id: "foreign", displayTitle: "别处", updatedAt: 12 },
      ],
      "newer",
      {
        sessionIds: ["older", "human-fork", "newer", "archived", "child"],
        archivedSessionIds: ["archived"],
      },
    );

    expect(rows).toEqual([
      {
        id: "human-fork",
        title: "今天的分支",
        updatedAt: 10,
        running: false,
        selected: false,
      },
      {
        id: "newer",
        title: "今天",
        updatedAt: 9,
        running: true,
        selected: true,
      },
      {
        id: "older",
        title: "昨晚",
        updatedAt: 1,
        running: false,
        selected: false,
      },
    ]);
  });

  it("selects the newest human fork through the client entry selector", () => {
    expect(
      selectCompanionSession(
        [
          { id: "root", updatedAt: 20 },
          { id: "human-fork", updatedAt: 30, parentId: "root" },
          { id: "subagent", updatedAt: 40, origin: "subagent" },
          { id: "archived", updatedAt: 50 },
        ],
        {
          sessionIds: ["root", "human-fork", "subagent", "archived"],
          archivedSessionIds: ["archived"],
        },
      ),
    ).toBe("human-fork");
  });

  it("keeps a manual selection when activity reorders the client rows", () => {
    const available = companionSessionList(
      [
        { id: "manual", displayTitle: "Manual", updatedAt: 10 },
        { id: "newest", displayTitle: "Newest", updatedAt: 20 },
      ],
      undefined,
      { sessionIds: ["manual", "newest"], archivedSessionIds: [] },
    );
    expect(
      resolveCompanionSessionSelection(
        "workspace-a",
        { workspaceId: "workspace-a", sessionId: "manual" },
        available,
        "newest",
      ),
    ).toBe("manual");
  });
});
