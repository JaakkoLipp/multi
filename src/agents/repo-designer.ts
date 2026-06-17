/**
 * Repo-mode designer: WorkItem + RepoContext -> RepoDesignSpec (which files to
 * touch and the change intent). Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { RepoDesignOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { REPO_DESIGNER_INSTRUCTIONS, renderRepoDesignerPrompt } from "./prompts.js";
import type { RepoDesignInput } from "./types.js";

export function makeRepoDesigner(model: MastraModelConfig) {
  const agent = new Agent({
    name: "repo-designer",
    id: "repo-designer",
    instructions: REPO_DESIGNER_INSTRUCTIONS,
    model,
  });
  return async (input: RepoDesignInput) =>
    generateStructured(agent, await renderRepoDesignerPrompt(input), RepoDesignOutput);
}
