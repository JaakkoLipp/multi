/**
 * Thin bridge over a Mastra Agent's structured-output generate call.
 *
 * Mastra's `agent.generate(prompt, { structuredOutput: { schema } })` runs the
 * Vercel AI SDK structured-output path under the hood (§6) and returns a result
 * whose `.object` is validated against the Zod schema. We re-parse with Zod here
 * so the rest of the engine always receives a value that satisfies our contract
 * types exactly, regardless of provider quirks.
 *
 * `jsonPromptInjection: true` makes this work even against LiteLLM-backed models
 * that don't natively support response_format/json_schema (e.g. local coder
 * models): Mastra falls back to system-prompt JSON coercion.
 */
import type { Agent } from "@mastra/core/agent";
import type { z } from "zod";

export async function generateStructured<T>(
  agent: Agent,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await agent.generate(prompt, {
    structuredOutput: { schema, jsonPromptInjection: true },
  });
  return schema.parse(result.object);
}
