/**
 * env -> typed, validated config.
 *
 * Headless: this module reads from a plain object (defaulting to process.env at
 * the CLI boundary) and never touches argv or stdout. The engine is handed a
 * fully-resolved PipelineConfig object; it never reads env itself.
 */
import { z } from "zod";

const intFromEnv = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().positive());

const ConfigSchema = z.object({
  litellmBaseUrl: z.string().url(),
  litellmApiKey: z.string().min(1),
  models: z.object({
    orchestrator: z.string().min(1),
    designer: z.string().min(1),
    developer: z.string().min(1),
    tester: z.string().min(1),
  }),
  maxWbsItems: intFromEnv(6),
  maxReworkAttempts: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? 2 : Number(v)))
    .pipe(z.number().int().nonnegative()),
  testTimeoutMs: intFromEnv(30000),
  concurrency: z.object({
    designer: intFromEnv(1),
    developer: intFromEnv(2),
    tester: intFromEnv(2),
  }),
  gates: z.object({
    // Quality gates run after unit tests pass; a failing gate routes the item
    // back to the developer as feedback (bounded by the rework cap). Default off
    // to keep the fast path fast; enable per gate via env or the CLI --gates flag.
    typecheck: z.boolean(),
    lint: z.boolean(),
    coverage: z.boolean(),
    coverageMin: z.number().min(0).max(100),
  }),
});

export type PipelineConfig = z.infer<typeof ConfigSchema>;

export type RawEnv = Record<string, string | undefined>;

/** Parse a boolean-ish env var ("1"/"true"/"yes"/"on" => true). */
function boolFromEnv(value: string | undefined, def: boolean): boolean {
  if (value === undefined || value === "") return def;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: RawEnv = process.env): PipelineConfig {
  const parsed = ConfigSchema.safeParse({
    litellmBaseUrl: env.LITELLM_BASE_URL ?? "http://localhost:4000/v1",
    litellmApiKey: env.LITELLM_API_KEY ?? "sk-nokey",
    models: {
      orchestrator: env.ORCHESTRATOR_MODEL ?? "gpt-4o",
      designer: env.DESIGNER_MODEL ?? "gpt-4o",
      developer: env.DEVELOPER_MODEL ?? "gpt-4o-mini",
      tester: env.TESTER_MODEL ?? "gpt-4o-mini",
    },
    maxWbsItems: env.MAX_WBS_ITEMS,
    maxReworkAttempts: env.MAX_REWORK_ATTEMPTS,
    testTimeoutMs: env.TEST_TIMEOUT_MS,
    concurrency: {
      designer: env.DESIGNER_CONCURRENCY,
      developer: env.DEVELOPER_CONCURRENCY,
      tester: env.TESTER_CONCURRENCY,
    },
    gates: {
      typecheck: boolFromEnv(env.GATE_TYPECHECK, false),
      lint: boolFromEnv(env.GATE_LINT, false),
      coverage: boolFromEnv(env.GATE_COVERAGE, false),
      coverageMin: env.COVERAGE_MIN === undefined || env.COVERAGE_MIN === "" ? 80 : Number(env.COVERAGE_MIN),
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid pipeline configuration:\n${issues}`);
  }
  return parsed.data;
}
