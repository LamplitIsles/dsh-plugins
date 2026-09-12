import { describe, expect, it } from "vitest";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { applyCompanionPrompt } from "../src/prompt.js";

describe("Companion prompt composition", () => {
  it("replaces Harness sections once while preserving persona, tools and context", () => {
    const persona = { name: "deployment:persona", text: "fixture persona" };
    const toolRules = { name: "tools:fixture", text: "fixture tool rules" };
    const assembly: PromptAssembly = {
      sections: [
        { name: "harness:identity", text: "fixture harness identity" },
        { name: "harness:source", text: "fixture source location" },
        { name: "app:web-surface", text: "fixture development guidance" },
        persona,
        toolRules,
      ],
      contexts: [{ name: "fixture:context", text: "current context" }],
      tools: [],
      variables: { fixture: "value" },
    };
    const contexts = assembly.contexts;
    const tools = assembly.tools;
    const variables = assembly.variables;
    applyCompanionPrompt(assembly);
    const first = [...assembly.sections];
    applyCompanionPrompt(assembly);
    expect(assembly.sections).toEqual(first);
    expect(assembly.sections.map((section) => section.name)).toEqual([
      "dsh-companion:base",
      "deployment:persona",
      "tools:fixture",
    ]);
    expect(assembly.sections.slice(1)).toEqual([persona, toolRules]);
    expect(assembly.contexts).toBe(contexts);
    expect(assembly.tools).toBe(tools);
    expect(assembly.variables).toBe(variables);
  });
});
