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
import { mkdir, rm, writeFile } from "node:fs/promises";
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

export interface SandboxRun {
  /** Absolute directory this attempt was materialized into. */
  dir: string;
  passed: boolean;
  stdout: string;
  stderr: string;
}

export interface RunTestsArgs {
  /** Absolute directory to create and run in (caller owns the layout/uniqueness). */
  dir: string;
  sourceCode: string;
  testSource: string;
  timeoutMs: number;
}

export async function runTests(args: RunTestsArgs): Promise<SandboxRun> {
  const { dir, sourceCode, testSource, timeoutMs } = args;

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, SOURCE_FILE), sourceCode, "utf8");
  await writeFile(path.join(dir, TEST_FILE), testSource, "utf8");
  // A self-contained vitest config so the child never inherits the project's
  // own test config (which would otherwise try to run the whole suite).
  await writeFile(
    path.join(dir, "vitest.config.ts"),
    [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({`,
      `  test: { include: ["${TEST_FILE}"], watch: false, environment: "node" },`,
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
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(
          error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed,
        );
        resolve({
          dir,
          passed: !error,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") + (timedOut ? `\n[sandbox] killed after ${timeoutMs}ms timeout` : ""),
        });
      },
    );
  });
}
