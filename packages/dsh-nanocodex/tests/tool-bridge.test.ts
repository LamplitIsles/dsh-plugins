import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  SessionId,
  SessionPreparation,
  SessionSeq,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { APPLY_PATCH_NAME } from "../src/constants.js";
import { createToolBridge } from "../src/tool-bridge.js";

describe("Nanocodex tool bridge", () => {
  it("persists the public parent-child dispatch relation", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000306")),
    );
    try {
      const session = preparation.session;
      let execution: unknown;
      const result = {
        isError: false,
        value: { total: 4 },
        content: [{ type: "text", text: '{"total":4}' }],
      } as const;
      const definition = {
        name: "roll_dice",
        description: "Roll a die",
        parameters: { type: "object", properties: {} },
        output: {
          schema: { type: "object", properties: {} },
          render: () => result.content,
        },
      };
      const tools = {
        schemas: () => [definition],
        get: () => definition,
        execute: async (input: unknown) => {
          execution = input;
          return result;
        },
      } as unknown as ToolRuntime;
      const agent = { ctx: root, session } as unknown as Agent;
      const bridge = createToolBridge({
        tools,
        agent,
        callbacks: {
          onCall: () => SessionSeq(0),
          onResult: () => undefined,
        },
        signal: new AbortController().signal,
      });
      const tool = bridge[0]!;
      await tool.handler(
        { sides: 6 },
        {
          callId: "child-call",
          parentCallId: "outer-exec",
          sessionId: String(session.id),
          model: "gpt-5.6-sol",
          signal: new AbortController().signal,
        },
      );

      expect(execution).toMatchObject({
        callId: "child-call",
        rootCallId: "outer-exec",
      });
      expect(
        session
          .snapshotEvents()
          .filter(
            (event) =>
              event.type === "tool/code-dispatch-start" ||
              event.type === "tool/code-dispatch",
          )
          .map((event) => event.type),
      ).toEqual(["tool/code-dispatch-start", "tool/code-dispatch"]);
      const [start, settle] = session
        .snapshotEvents()
        .filter(
          (event) =>
            event.type === "tool/code-dispatch-start" ||
            event.type === "tool/code-dispatch",
        );
      expect(start).toMatchObject({
        type: "tool/code-dispatch-start",
        data: {
          rootCallId: "outer-exec",
          parentCallId: "outer-exec",
          subCallId: "child-call",
          name: "roll_dice",
          arguments: { sides: 6 },
        },
      });
      expect(settle).toMatchObject({
        type: "tool/code-dispatch",
        data: {
          rootCallId: "outer-exec",
          parentCallId: "outer-exec",
          subCallId: "child-call",
          name: "roll_dice",
          arguments: { sides: 6 },
          isError: false,
          content: result.content,
        },
      });
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });

  it("translates a raw custom patch call into canonical DSH arguments", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    await sessions;
    const preparation = SessionPreparation.create(
      root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000309")),
    );
    try {
      const session = preparation.session;
      let execution: unknown;
      const patch = "*** Begin Patch\n*** End Patch\n";
      const definition = {
        name: APPLY_PATCH_NAME,
        description: "Apply a patch",
        parameters: { type: "object", properties: {} },
        output: {
          schema: { type: "object", properties: {} },
          render: () => [{ type: "text" as const, text: "Applied" }],
        },
      };
      const tools = {
        schemas: () => [definition],
        get: () => definition,
        execute: async (input: unknown) => {
          execution = input;
          return {
            isError: false,
            value: { status: "applied" },
            content: [{ type: "text" as const, text: "Applied" }],
          };
        },
      } as unknown as ToolRuntime;
      const bridge = createToolBridge({
        tools,
        agent: { ctx: root, session } as unknown as Agent,
        callbacks: {
          onCall: () => SessionSeq(0),
          onResult: () => undefined,
        },
        signal: new AbortController().signal,
        customDefinitions: new Map([
          [
            APPLY_PATCH_NAME,
            {
              type: "custom" as const,
              description: "Apply a patch",
              format: {
                type: "grammar" as const,
                syntax: "lark" as const,
                definition: "start: patch",
              },
            },
          ],
        ]),
      });

      const tool = bridge[0]!;
      expect(tool.definition).toMatchObject({
        type: "custom",
        format: { type: "grammar", syntax: "lark" },
      });
      await expect(
        tool.handler(patch, {
          callId: "patch-call",
          parentCallId: "",
          sessionId: String(session.id),
          model: "gpt-5.6-sol",
          signal: new AbortController().signal,
        }),
      ).resolves.toBe("Applied");
      expect(execution).toMatchObject({
        name: APPLY_PATCH_NAME,
        arguments: { patch },
      });
    } finally {
      preparation[Symbol.dispose]();
      await sessions.dispose();
    }
  });
});
