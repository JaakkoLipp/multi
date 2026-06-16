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
import { z } from "zod";

const STRUCTURED_OUTPUT_OPTIONS = { jsonPromptInjection: true } as const;

/**
 * Render a Zod failure into a short, model-readable list of field issues so the
 * repair prompt can point the model at exactly what to fix.
 */
function formatValidationError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `- ${path}: ${issue.message}`;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the corrective re-ask: the original prompt plus an appended section
 * showing the model the output it produced, why it failed schema validation,
 * and an instruction to return a corrected, schema-conforming value.
 */
function buildRepairPrompt(
  prompt: string,
  previousOutput: unknown,
  err: unknown,
): string {
  return [
    prompt,
    "",
    "---",
    "Your previous response failed schema validation and could not be used.",
    "",
    "Previous output:",
    JSON.stringify(previousOutput),
    "",
    "Validation errors:",
    formatValidationError(err),
    "",
    "Return corrected output that exactly matches the required schema. " +
      "Fix the issues above and do not introduce new ones.",
  ].join("\n");
}

export async function generateStructured<T>(
  agent: Agent,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const result = await agent.generate(prompt, {
    structuredOutput: { schema, ...STRUCTURED_OUTPUT_OPTIONS },
  });

  try {
    return schema.parse(result.object);
  } catch (firstError) {
    // Exactly ONE structured-output repair attempt. The project brief scopes
    // out "provider fallback/retry beyond one structured-output repair", which
    // means a single corrective re-ask IS in scope but any further retry is not.
    const repairPrompt = buildRepairPrompt(prompt, result.object, firstError);
    const repaired = await agent.generate(repairPrompt, {
      structuredOutput: { schema, ...STRUCTURED_OUTPUT_OPTIONS },
    });

    try {
      return schema.parse(repaired.object);
    } catch (secondError) {
      const detail = formatValidationError(secondError);
      throw new Error(
        `Structured output failed schema validation after one repair attempt:\n${detail}`,
        { cause: secondError },
      );
    }
  }
}
