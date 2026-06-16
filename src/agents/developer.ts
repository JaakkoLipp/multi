/**
 * Developer stage: DesignSpec (+ optional failing-test feedback on rework) ->
 * CodeArtifact source. Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { CodeOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { DEVELOPER_INSTRUCTIONS, renderDeveloperPrompt } from "./prompts.js";
import type { DevelopInput } from "./types.js";

export function makeDeveloper(model: MastraModelConfig) {
  const agent = new Agent({
    name: "developer",
    id: "developer",
    instructions: DEVELOPER_INSTRUCTIONS,
    model,
  });
  return (input: DevelopInput) =>
    generateStructured(agent, renderDeveloperPrompt(input), CodeOutput);
}
