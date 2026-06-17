/**
 * llm.ts — the AI-SDK provider bound to the LiteLLM gateway, plus a structured
 * generation helper.
 *
 * Verified path (see DECISIONS): `@ai-sdk/openai`'s `createOpenAI({ baseURL })`
 * pointed at the LiteLLM OpenAI-compatible gateway, with the AI SDK's
 * `generateObject` for Zod-schema structured output. We use `openai.chat(id)`
 * and `strictJsonSchema: false` so arbitrary LiteLLM-backed models (including
 * local coder models) don't trip OpenAI's strict json_schema validation.
 *
 * The brief mandates Mastra as the agent framework; the model-driven stages wrap
 * this helper with their Mastra `Agent` definitions (see agents/real.ts). This
 * module stays a pure, headless utility: no `vscode`, no CLI, no rendering.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import type { z } from "zod";
import type { PipelineConfig } from "./config.js";

export interface Llm {
  generateStructured<T>(args: {
    model: string;
    schema: z.ZodType<T>;
    system: string;
    prompt: string;
  }): Promise<T>;
}

export function createLlm(config: PipelineConfig): Llm {
  const provider = createOpenAI({
    baseURL: config.litellmBaseUrl,
    apiKey: config.litellmApiKey,
  });

  return {
    async generateStructured({ model, schema, system, prompt }) {
      const { object } = await generateObject({
        model: provider.chat(model),
        schema,
        system,
        prompt,
        providerOptions: { openai: { strictJsonSchema: false } },
      });
      return object;
    },
  };
}
