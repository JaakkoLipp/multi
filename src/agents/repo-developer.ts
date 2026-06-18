/**
 * Repo-mode developer: RepoDesignSpec + RepoContext (+ failing-check feedback on
 * rework) -> a multi-file Patch (PatchOutput). Model-driven via a Mastra Agent.
 */
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { PatchOutput } from "../contracts.js";
import { generateStructured } from "./mastra.js";
import { REPO_DEVELOPER_INSTRUCTIONS, renderRepoDeveloperPrompt } from "./prompts.js";
import type { RepoDevelopInput } from "./types.js";

export function makeRepoDeveloper(model: MastraModelConfig) {
  const agent = new Agent({
    name: "repo-developer",
    id: "repo-developer",
    instructions: REPO_DEVELOPER_INSTRUCTIONS,
    model,
  });
  return async (input: RepoDevelopInput) =>
    generateStructured(agent, await renderRepoDeveloperPrompt(input), PatchOutput);
}
