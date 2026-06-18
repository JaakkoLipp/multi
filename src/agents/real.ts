/**
 * The real, LLM-backed agent bundle: Mastra Agents per stage, each bound to a
 * model served by the LiteLLM gateway via the AI SDK's OpenAI-compatible
 * provider. Loaded lazily by the CLI so the engine/stub/test paths never import
 * Mastra or touch the network.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { PipelineConfig } from "../config.js";
import { makeDesigner } from "./designer.js";
import { makeDeveloper } from "./developer.js";
import { makeOrchestrator } from "./orchestrator.js";
import { makeRepoDesigner } from "./repo-designer.js";
import { makeRepoDeveloper } from "./repo-developer.js";
import { makeReviewer } from "./reviewer.js";
import { makeTester } from "./tester.js";
import type { Agents } from "./types.js";

export function createRealAgents(config: PipelineConfig): Agents {
  const provider = createOpenAI({
    baseURL: config.litellmBaseUrl,
    apiKey: config.litellmApiKey,
  });
  const model = (id: string): MastraModelConfig => provider.chat(id);

  const orchestrate = makeOrchestrator(model(config.models.orchestrator));
  const design = makeDesigner(model(config.models.designer));
  const develop = makeDeveloper(model(config.models.developer));
  const writeTests = makeTester(model(config.models.tester));
  const review = makeReviewer(model(config.models.reviewer));
  const designRepo = makeRepoDesigner(model(config.models.designer));
  const developRepo = makeRepoDeveloper(model(config.models.developer));

  return { orchestrate, design, develop, writeTests, review, designRepo, developRepo };
}
