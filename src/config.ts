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
  /** "module" generates standalone modules; "repo" edits an existing repository. */
  mode: z.enum(["module", "repo"]),
  repo: z.object({
    source: z.string().nullable(), // git URL or local path to the target repo
    ref: z.string(), // base branch/commit
    testCommand: z.string(), // e.g. "npm test" or "node --test"
    lintCommand: z.string().nullable(),
    buildCommand: z.string().nullable(),
  }),
  litellmBaseUrl: z.string().url(),
  litellmApiKey: z.string().min(1),
  models: z.object({
    orchestrator: z.string().min(1),
    designer: z.string().min(1),
    developer: z.string().min(1),
    tester: z.string().min(1),
    reviewer: z.string().min(1),
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
  review: z.object({
    // A critic reviews the developer's code against the spec before testing;
    // rejections reuse the rework edge. Off by default.
    enabled: z.boolean(),
  }),
  packaging: z.object({
    // After the sink, assemble passing modules into one consumable library and
    // run a cross-module integration test. Off by default.
    enabled: z.boolean(),
    name: z.string().min(1),
  }),
  github: z.object({
    // GitHub App (bot identity) credentials. The app authenticates as an
    // installation: a short-lived token minted from appId + private key, scoped
    // to the installation. Never a hard-coded or harness credential.
    appId: z.string().nullable(),
    privateKey: z.string().nullable(),
    installationId: z.number().int().nullable(),
    owner: z.string().nullable(),
    repo: z.string().nullable(),
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

/**
 * Normalize a PEM private key supplied via env. Supports a literal multi-line
 * PEM, a single line with escaped "\n", or a base64-encoded PEM (common when a
 * key is stuffed into a single env var/secret).
 */
function normalizePem(value: string | undefined): string | null {
  if (!value || value.trim() === "") return null;
  if (value.includes("BEGIN") && value.includes("PRIVATE KEY")) {
    return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.includes("BEGIN") && decoded.includes("PRIVATE KEY")) return decoded;
  } catch {
    /* fall through */
  }
  return value.replace(/\\n/g, "\n");
}

export function loadConfig(env: RawEnv = process.env): PipelineConfig {
  const parsed = ConfigSchema.safeParse({
    mode: env.MODE === "repo" ? "repo" : "module",
    repo: {
      source: env.REPO_SOURCE ?? null,
      ref: env.REPO_REF ?? "main",
      testCommand: env.REPO_TEST_CMD ?? "npm test",
      lintCommand: env.REPO_LINT_CMD ?? null,
      buildCommand: env.REPO_BUILD_CMD ?? null,
    },
    litellmBaseUrl: env.LITELLM_BASE_URL ?? "http://localhost:4000/v1",
    litellmApiKey: env.LITELLM_API_KEY ?? "sk-nokey",
    models: {
      orchestrator: env.ORCHESTRATOR_MODEL ?? "gpt-4o",
      designer: env.DESIGNER_MODEL ?? "gpt-4o",
      developer: env.DEVELOPER_MODEL ?? "gpt-4o-mini",
      tester: env.TESTER_MODEL ?? "gpt-4o-mini",
      reviewer: env.REVIEWER_MODEL ?? env.DESIGNER_MODEL ?? "gpt-4o",
    },
    maxWbsItems: env.MAX_WBS_ITEMS,
    maxReworkAttempts: env.MAX_REWORK_ATTEMPTS,
    testTimeoutMs: env.TEST_TIMEOUT_MS,
    concurrency: {
      designer: env.DESIGNER_CONCURRENCY,
      developer: env.DEVELOPER_CONCURRENCY,
      tester: env.TESTER_CONCURRENCY,
    },
    review: {
      enabled: boolFromEnv(env.REVIEW_ENABLED, false),
    },
    packaging: {
      enabled: boolFromEnv(env.PACKAGE_ENABLED, false),
      name: env.PACKAGE_NAME ?? "generated-utils",
    },
    github: {
      appId: env.GITHUB_APP_ID ?? null,
      privateKey: normalizePem(env.GITHUB_PRIVATE_KEY),
      installationId:
        env.GITHUB_INSTALLATION_ID && env.GITHUB_INSTALLATION_ID !== ""
          ? Number(env.GITHUB_INSTALLATION_ID)
          : null,
      owner: env.GITHUB_OWNER ?? null,
      repo: env.GITHUB_REPO ?? null,
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
