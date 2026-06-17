/**
 * Integration & packaging stage.
 *
 * After every work item reaches a terminal state, the passing modules are
 * assembled into a single consumable library: one source file per function, a
 * barrel `index.ts` re-exporting them all, a `package.json` + `README.md`, and a
 * cross-module `integration.test.ts` that imports the assembled barrel and is
 * actually executed (the integration concern: do the independently-built modules
 * coexist and all import together without collisions?).
 *
 * Headless: writes files and runs vitest via the sandbox; emits no output and
 * imports nothing CLI-only. The engine turns the result into a pipeline.packaged
 * event.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runVitest } from "./sandbox.js";

export interface PackagedModule {
  functionName: string;
  sourceCode: string;
}

export interface PackageResult {
  dir: string;
  /** Function names actually included in the barrel (deduplicated). */
  modules: string[];
  integrationPassed: boolean;
  output: string;
}

export interface AssembleArgs {
  outDir: string;
  name: string;
  modules: PackagedModule[];
  timeoutMs: number;
}

export async function assemblePackage(args: AssembleArgs): Promise<PackageResult> {
  const { outDir, name, timeoutMs } = args;

  // Deduplicate by function name (a later collision would break the barrel).
  const seen = new Set<string>();
  const modules = args.modules.filter((m) => {
    if (seen.has(m.functionName)) return false;
    seen.add(m.functionName);
    return true;
  });
  const names = modules.map((m) => m.functionName);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "src"), { recursive: true });

  for (const m of modules) {
    await writeFile(path.join(outDir, "src", `${m.functionName}.ts`), m.sourceCode, "utf8");
  }

  const barrel = names.map((n) => `export * from "./src/${n}.js";`).join("\n") + "\n";
  await writeFile(path.join(outDir, "index.ts"), barrel, "utf8");

  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        description: "Library assembled by the agent pipeline from passing work items.",
        module: "index.ts",
        types: "index.ts",
        exports: { ".": "./index.ts" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeFile(
    path.join(outDir, "README.md"),
    [`# ${name}`, "", "Assembled by the agent pipeline. Exports:", "", ...names.map((n) => `- \`${n}\``), ""].join("\n"),
    "utf8",
  );

  // Integration smoke test: every function is importable from the barrel and is
  // a callable export. This is the cross-module check unit tests can't make.
  await writeFile(
    path.join(outDir, "integration.test.ts"),
    [
      `import { describe, it, expect } from "vitest";`,
      `import * as lib from "./index.js";`,
      ``,
      `describe("assembled package", () => {`,
      `  it("exports every function from the barrel", () => {`,
      ...names.map((n) => `    expect(typeof lib.${n}).toBe("function");`),
      `    expect(Object.keys(lib).sort()).toEqual([${names.map((n) => `"${n}"`).sort().join(", ")}]);`,
      `  });`,
      `});`,
      ``,
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(outDir, "vitest.config.ts"),
    [
      `import { defineConfig } from "vitest/config";`,
      `export default defineConfig({`,
      `  test: { include: ["integration.test.ts"], watch: false, environment: "node" },`,
      `});`,
      "",
    ].join("\n"),
    "utf8",
  );

  const run = names.length > 0 ? await runVitest(outDir, timeoutMs) : { passed: true, output: "" };
  return { dir: outDir, modules: names, integrationPassed: run.passed, output: run.output };
}
