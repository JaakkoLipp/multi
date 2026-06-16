/**
 * Reviewer stage: a critic that reviews a CodeArtifact against its spec before
 * testing. Returns { approved, notes }; the engine routes a rejection back to
 * the developer via the rework edge. Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { ReviewOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { renderReviewerPrompt, REVIEWER_INSTRUCTIONS } from "./prompts.js";
import type { ReviewInput } from "./types.js";

export function makeReviewer(model: MastraModelConfig) {
  const agent = new Agent({
    name: "reviewer",
    id: "reviewer",
    instructions: REVIEWER_INSTRUCTIONS,
    model,
  });
  return (input: ReviewInput) =>
    generateStructured(agent, renderReviewerPrompt(input), ReviewOutput);
}
