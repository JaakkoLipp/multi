/**
 * Orchestrator stage: prompt -> WorkItem[] (as WbsOutput, before the engine
 * assigns ids). Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { WbsOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { ORCHESTRATOR_INSTRUCTIONS, renderOrchestratorPrompt } from "./prompts.js";

export function makeOrchestrator(model: MastraModelConfig) {
  const agent = new Agent({
    name: "orchestrator",
    id: "orchestrator",
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    model,
  });
  return (prompt: string, maxItems: number) =>
    generateStructured(agent, renderOrchestratorPrompt(prompt, maxItems), WbsOutput);
}
