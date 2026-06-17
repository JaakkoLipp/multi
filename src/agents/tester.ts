/**
 * Tester stage (authoring half): writes the Vitest spec for a module. The
 * engine's tester worker then runs that spec in the sandbox and routes on the
 * pass/fail result. Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { TestOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { TESTER_INSTRUCTIONS, renderTesterPrompt } from "./prompts.js";
import type { WriteTestsInput } from "./types.js";

export function makeTester(model: MastraModelConfig) {
  const agent = new Agent({
    name: "tester",
    id: "tester",
    instructions: TESTER_INSTRUCTIONS,
    model,
  });
  return (input: WriteTestsInput) =>
    generateStructured(agent, renderTesterPrompt(input), TestOutput);
}
