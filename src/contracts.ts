/**
 * Data contracts for the pipeline.
 *
 * These Zod schemas are the single source of truth for the shapes that flow
 * between stages AND for the structured-output the LLM stages must produce.
 * Inferred TypeScript types are exported alongside each schema.
 *
 * Extension-readiness (see README / DECISIONS D-EXT): every shape here is plain
 * JSON data — objects, arrays, strings, numbers, booleans, null. No Date, Map,
 * Set, class instances or functions. `null` is used instead of `undefined` for
 * "absent" fields so payloads survive JSON.parse(JSON.stringify(...)) unchanged.
 */
import { z } from "zod";

export const Stage = z.enum(["designer", "developer", "tester"]);
export type Stage = z.infer<typeof Stage>;

export const WorkItem = z.object({
  id: z.string(), // "wi-001"
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  /** Ids of work items this one builds upon. Empty = independent (a DAG root). */
  dependsOn: z.array(z.string()).default([]),
});
export type WorkItem = z.infer<typeof WorkItem>;

export const DesignSpec = z.object({
  workItemId: z.string(),
  functionName: z.string(),
  signature: z.string(), // "export function slugify(text: string): string"
  behavior: z.string(),
  edgeCases: z.array(z.string()),
  examples: z.array(z.string()),
});
export type DesignSpec = z.infer<typeof DesignSpec>;

export const CodeArtifact = z.object({
  workItemId: z.string(),
  functionName: z.string(),
  sourceCode: z.string(), // full module source for this item
  attempt: z.number().int().default(1),
  feedback: z.string().nullable().default(null), // failing-test feedback on rework
});
export type CodeArtifact = z.infer<typeof CodeArtifact>;

export const TestResult = z.object({
  workItemId: z.string(),
  functionName: z.string(),
  passed: z.boolean(),
  testSource: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  sourceCode: z.string(), // carry code forward so the sink has the final artifact
});
export type TestResult = z.infer<typeof TestResult>;

export const FinalRecord = z.object({
  workItem: WorkItem,
  passed: z.boolean(),
  attempts: z.number().int(),
  sourceCode: z.string().nullable(),
  testSource: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type FinalRecord = z.infer<typeof FinalRecord>;

/**
 * The schemas the LLM stages must emit. They intentionally omit fields the
 * engine fills in itself (ids, attempt counters, carried-forward code) so the
 * model is only ever asked for the creative part.
 */
export const WbsOutput = z.object({
  items: z
    .array(
      z.object({
        /** A short stable handle the model uses to express dependencies between
         * items (ids are assigned by the engine, so the model can't reference
         * them yet). Optional: omit for fully independent work. */
        key: z.string().optional(),
        title: z.string(),
        description: z.string(),
        acceptanceCriteria: z.array(z.string()),
        /** Keys of other items this one depends on. */
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type WbsOutput = z.infer<typeof WbsOutput>;

export const DesignOutput = DesignSpec.omit({ workItemId: true });
export type DesignOutput = z.infer<typeof DesignOutput>;

export const CodeOutput = z.object({
  functionName: z.string(),
  sourceCode: z.string(),
});
export type CodeOutput = z.infer<typeof CodeOutput>;

export const TestOutput = z.object({
  testSource: z.string(),
});
export type TestOutput = z.infer<typeof TestOutput>;
