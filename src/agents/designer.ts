/**
 * Designer stage: WorkItem -> DesignSpec (minus workItemId, which the engine
 * already knows). Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { DesignOutput, type WorkItem } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { DESIGNER_INSTRUCTIONS, renderDesignerPrompt } from "./prompts.js";

export function makeDesigner(model: MastraModelConfig) {
  const agent = new Agent({
    name: "designer",
    id: "designer",
    instructions: DESIGNER_INSTRUCTIONS,
    model,
  });
  return (item: WorkItem) =>
    generateStructured(agent, renderDesignerPrompt(item), DesignOutput);
}
