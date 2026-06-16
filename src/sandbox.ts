/**
 * D3 — Test-execution sandbox.
 *
 * The tester writes a Vitest spec against the developer's module and runs it for
 * real. Isolation strategy:
 *   - A fresh directory per item per attempt under the run's workspace, so a
 *     retry never sees stale files and concurrent items never collide.
 *   - Execution in a child process (node:child_process.execFile) running the
 *     project's local `vitest run`, which transforms TS on the fly (no separate
 *     tsc step) — this is why D4 keeps the target language TypeScript + Vitest.
 *   - A hard wall-clock timeout that kills the process group.
 *
 * SECURITY: this runs model-generated code. There is no kernel-level sandbox
 * here (no container/VM). It is intended for a trusted local machine only. See
 * the README's security note. We do not grant the child anything beyond a clean
 * temp cwd and inherited PATH; network is not explicitly firewalled.
 *
 * Headless: emits no output, imports nothing from `vscode` or any renderer.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestBin = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);

export const SOURCE_MODULE = "module";
export const SOURCE_FILE = `${SOURCE_MODULE}.ts`;
export const TEST_FILE = `${SOURCE_MODULE}.test.ts`;
/** The import specifier generated tests must use to reach the module under test. */
export const SOURCE_IMPORT = `./${SOURCE_MODULE}`;

/**
 * Defense-in-depth import allowlist for the model-generated SOURCE module.
 *
 * The developer agent is instructed that the generated module must have NO
 * imports and NO external dependencies (see DEVELOPER_INSTRUCTIONS). This
 * function scans the source for module specifiers that pull in anything outside
 * the file itself, so such code is rejected BEFORE it ever executes. It applies
 * ONLY to the generated source — the test file legitimately imports `vitest`
 * and `./module`.
 *
 * A specifier is DISALLOWED when it is a "bare" specifier: it does NOT start
 * with "./", "../", or "/". This means node: builtins ("node:fs"), node bare
 * builtins ("fs"), and npm packages ("lodash") are all flagged. Relative
 * specifiers ("./util", "../x") are allowed (not a security risk).
 *
 * This is a deliberately simple regex scan, not a full parser — it covers the
 * common forms: `import ... from "X"`, `import "X"`, `export ... from "X"`, and
 * `require("X")`.
 */
export function findDisallowedImports(sourceCode: string): string[] {
  const found: string[] = [];

  // `import ... from "X"` and `export ... from "X"` (the `from` clause).
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  // Side-effect import: `import "X"` (no `from`).
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  // CommonJS `require("X")`.
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [fromRe, bareImportRe, requireRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sourceCode)) !== null) {
      const spec = m[1];
      if (spec === undefined) continue;
      // Relative / absolute path specifiers are allowed; everything else
      // (bare names, node: builtins) is disallowed.
      const isRelative =
        spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
      if (!isRelative && !found.includes(spec)) {
        found.push(spec);
      }
    }
  }

  return found;
}

export interface SandboxRun {
  /** Absolute directory this attempt was materialized into. */
  dir: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  /** Line-coverage percentage of the module under test, when coverage was collected. */
  coveragePct: number | null;
}

export interface RunTestsArgs {
  /** Absolute directory to create and run in (caller owns the layout/uniqueness). */
  dir: string;
  sourceCode: string;
  testSource: string;
  timeoutMs: number;
  /** Abort the child process early (used by the engine's cancellation path). */
  signal?: AbortSignal;
  /** Instrument the run and report line coverage of the module (coverage gate). */
  collectCoverage?: boolean;
}

export async function runTests(args: RunTestsArgs): Promise<SandboxRun> {
  const { dir, sourceCode, testSource, timeoutMs, signal, collectCoverage } = args;

  // Defense-in-depth: reject model-generated source that pulls in external
  // modules before writing files or spawning vitest. The engine treats this as
  // a normal test failure and routes the feedback back to the developer.
  const disallowed = findDisallowedImports(sourceCode);
  if (disallowed.length > 0) {
    return {
      dir,
      passed: false,
      stdout: "",
      stderr: `[sandbox] disallowed imports in generated module: ${disallowed.join(", ")}`,
      coveragePct: null,
    };
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, SOURCE_FILE), sourceCode, "utf8");
  await writeFile(path.join(dir, TEST_FILE), testSource, "utf8");
  // A self-contained vitest config so the child never inherits the project's
  // own test config (which would otherwise try to run the whole suite).
  const coverageBlock = collectCoverage
    ? `, coverage: { enabled: true, provider: "v8", reporter: ["json-summary"], reportsDirectory: "coverage", include: ["${SOURCE_FILE}"], all: false }`
    : "";
  await writeFile(
    path.join(dir, "vitest.config.ts"),
    [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({`,
      `  test: { include: ["${TEST_FILE}"], watch: false, environment: "node"${coverageBlock} },`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );

  return await new Promise<SandboxRun>((resolve) => {
    execFile(
      vitestBin,
      ["run", "--root", dir, "--no-color", "--config", path.join(dir, "vitest.config.ts")],
      {
        cwd: dir,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
        signal,
      },
      async (error, stdout, stderr) => {
        const killed = Boolean(
          error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed,
        );
        const aborted = Boolean(signal?.aborted);
        const reason = aborted ? "cancelled" : killed ? `killed after ${timeoutMs}ms timeout` : "";
        const coveragePct = collectCoverage && !error ? await readCoverage(dir) : null;
        resolve({
          dir,
          passed: !error,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") + (reason ? `\n[sandbox] ${reason}` : ""),
          coveragePct,
        });
      },
    );
  });
}

async function readCoverage(dir: string): Promise<number | null> {
  try {
    const raw = await readFile(path.join(dir, "coverage", "coverage-summary.json"), "utf8");
    const summary = JSON.parse(raw) as { total?: { lines?: { pct?: number } } };
    const pct = summary.total?.lines?.pct;
    return typeof pct === "number" ? pct : null;
  } catch {
    return null;
  }
}

// --- Quality gates (run after unit tests pass) -------------------------------

export interface GateResult {
  ok: boolean;
  output: string;
}

const tscBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const eslintBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "eslint.cmd" : "eslint");
const eslintConfig = path.join(projectRoot, "eslint.config.mjs");

function runBin(bin: string, bargs: string[], cwd: string, timeoutMs: number): Promise<GateResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      bargs,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout ?? ""}${stderr ?? ""}`.trim() });
      },
    );
  });
}

/** Type-check the generated module with a strict, standalone tsc invocation. */
export function typecheckModule(dir: string, timeoutMs: number): Promise<GateResult> {
  return runBin(
    tscBin,
    [
      "--noEmit", "--strict", "--skipLibCheck",
      "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler",
      SOURCE_FILE,
    ],
    dir,
    timeoutMs,
  );
}

/** Lint the generated module against the project's flat ESLint config. */
export function lintModule(dir: string, timeoutMs: number): Promise<GateResult> {
  return runBin(eslintBin, ["--config", eslintConfig, SOURCE_FILE], dir, timeoutMs);
}
