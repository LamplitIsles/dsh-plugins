import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionSnapshot } from "nanocodex/node";
import { expect, it } from "vitest";
import { NanocodexEngine } from "../src/engine.js";
import { memoryCheckpoints } from "./checkpoint-store-fixture.js";

it("keeps image-heavy snapshots private and replaces the previous session checkpoint", async () => {
  const root = new Context();
  const sessions = root.plugin(SessionStore);
  await sessions;
  const preparation = SessionPreparation.create(
    root.sessions.prepare(SessionId("018f1f9a-7b3c-7a10-8000-000000000321")),
  );
  const session = preparation.session;
  const detach = root.sessions.enter(session);
  root.sessions.announce(session);
  const store = memoryCheckpoints();
  const agent = { session } as Agent;
  const snapshot = {
    model: "gpt-5.6-sol",
    history: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${"A".repeat(2_000_000)}`,
          },
        ],
      },
    ],
  } as unknown as SessionSnapshot;
  try {
    await new NanocodexEngine(root, store).persistCheckpoint(
      agent,
      "openai",
      "gpt-5.6-sol",
      snapshot,
      new AbortController().signal,
    );
    expect(store.get(session.id)?.snapshot).toEqual(snapshot);
    const replacement = { ...snapshot, history: [] };
    await new NanocodexEngine(root, store).persistCheckpoint(
      agent,
      "openai",
      "gpt-5.6-sol",
      replacement,
      new AbortController().signal,
    );
    expect(store.get(session.id)?.snapshot).toEqual(replacement);
    const contexts = session
      .snapshotEvents()
      .filter((event) => event.type === "request/context");
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.data).toEqual({
        provider: "openai",
        model: "gpt-5.6-sol",
        contextWindow: 200_000,
      });
      expect(JSON.stringify(context).length).toBeLessThan(1024);
    }
  } finally {
    detach();
    preparation[Symbol.dispose]();
    await sessions.dispose();
  }
});
