import { memoryCheckpoints } from "./checkpoint-store-fixture.js";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import {
  SessionId,
  SessionPreparation,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { NanocodexAgent } from "../src/agent.js";
import { NanocodexEngine, type EngineRunResult } from "../src/engine.js";
import type { SessionSnapshot } from "nanocodex/node";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class BlockingEngine extends NanocodexEngine {
  readonly started = deferred<void>();
  private calls = 0;

  override async run(
    ...args: Parameters<NanocodexEngine["run"]>
  ): Promise<EngineRunResult> {
    const signal = args[6];
    this.calls += 1;
    if (this.calls === 1) {
      this.started.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return {
      provider: "openai",
      model: "gpt-5.6-sol",
      automaticCompactions: [],
      snapshot: {
        version: 1,
        model: "gpt-5.6-sol",
        lineage_id: "fixture",
        prompt_cache_key: "fixture",
        workspace: "/tmp",
        canonical_context: {},
        history: [],
      } as SessionSnapshot,
    };
  }
}

describe("NanocodexAgent queue boundary", () => {
  it("keeps queued ordinary input when the active turn is stopped", async () => {
    const root = new Context();
    const sessions = root.plugin(SessionStore);
    const agents = root.plugin(AgentRegistry);
    const prompts = root.plugin(SystemPrompt);
    await Promise.all([sessions, agents, prompts]);
    const id = SessionId("018f1f9a-7b3c-7a10-8000-000000000099");
    const preparation = SessionPreparation.create(root.sessions.prepare(id));
    const engine = new BlockingEngine(root, memoryCheckpoints());
    const agent = new NanocodexAgent(root, id, {}, preparation.session, engine);
    const detachSession = root.sessions.enter(preparation.session);
    const detachAgent = root.agents.enter(agent, undefined);
    root.agents.announce(agent);
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "first" }],
          source: { kind: "user" },
        }),
      );
      await engine.started.promise;
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "second" }],
          source: { kind: "user" },
        }),
      );
      agent.cancel({ kind: "user" }, { keepInbox: true });
      await agent.whenIdle();

      const users = agent.session
        .deriveMessages()
        .filter((message) => message.role === "user")
        .map((message) =>
          message.content[0]?.type === "text" ? message.content[0].text : "",
        );
      expect(users).toEqual(["first", "second"]);
      expect(
        agent.session
          .snapshotEvents()
          .filter((event) => event.type === "turn/end")
          .map((event) => event.data.reason.kind),
      ).toEqual(["aborted", "completed"]);
    } finally {
      agent.cancel({ kind: "disposed" });
      await agent.dispose();
      detachAgent();
      detachSession();
      preparation[Symbol.dispose]();
      await prompts.dispose();
      await agents.dispose();
      await sessions.dispose();
    }
  });
});
