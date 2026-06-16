/**
 * Quality gates (typecheck + lint + coverage). Each gate runs after unit tests
 * pass; a failing gate routes the item back to the developer as feedback, and
 * is surfaced as an item.gate event. These tests drive the gates directly
 * against the sandbox (fast, deterministic) and end-to-end through the engine.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CodeOutput, DesignOutput, TestOutput, WbsOutput } from "../src/contracts.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { lintModule, runTests, SOURCE_IMPORT, typecheckModule } from "../src/sandbox.js";
import type { Agents, DesignInput, DevelopInput, WriteTestsInput } from "../src/agents/types.js";
import { tmpWorkspace } from "./helpers.js";

const PASS_TEST = `import { it, expect } from "vitest";
import { f } from "${SOURCE_IMPORT}";
it("f", () => { expect(f(2)).toBe(4); });
`;

/** Single-item agents producing the given source + a passing/lenient test. */
function oneItemAgents(sourceCode: string, testSource = PASS_TEST): Agents {
  return {
    async orchestrate(): Promise<WbsOutput> {
      return { items: [{ key: "f", title: "f", description: "fn", acceptanceCriteria: ["ok"], dependsOn: [] }] };
    },
    async design(_input: DesignInput): Promise<DesignOutput> {
      return { functionName: "f", signature: "export function f(n: number): number", behavior: "doubles", edgeCases: [], examples: [] };
    },
    async develop(_input: DevelopInput): Promise<CodeOutput> {
      return { functionName: "f", sourceCode };
    },
    async writeTests(_input: WriteTestsInput): Promise<TestOutput> {
      return { testSource };
    },
  };
}

describe("quality gates (sandbox-level)", () => {
  it("typecheckModule passes clean code and fails type errors", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const good = path.join(dir, "good");
      const bad = path.join(dir, "bad");
      await runTests({ dir: good, sourceCode: "export function f(n: number): number { return n * 2; }\n", testSource: PASS_TEST, timeoutMs: 60_000 });
      await runTests({ dir: bad, sourceCode: "export function f(n: number): number { return n * 2; }\nconst x: string = 123;\n", testSource: PASS_TEST, timeoutMs: 60_000 });

      expect((await typecheckModule(good, 60_000)).ok).toBe(true);
      const badResult = await typecheckModule(bad, 60_000);
      expect(badResult.ok).toBe(false);
      expect(badResult.output).toMatch(/not assignable|type/i);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("lintModule flags a lint violation", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const clean = path.join(dir, "clean");
      const dirty = path.join(dir, "dirty");
      await runTests({ dir: clean, sourceCode: "export function f(n: number): number { return n * 2; }\n", testSource: PASS_TEST, timeoutMs: 60_000 });
      await runTests({ dir: dirty, sourceCode: "export function f(n: number): number { var y = n; return y * 2; }\n", testSource: PASS_TEST, timeoutMs: 60_000 });

      expect((await lintModule(clean, 60_000)).ok).toBe(true);
      expect((await lintModule(dirty, 60_000)).ok).toBe(false); // no-var
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("runTests reports coverage percentage when requested", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      // Test only exercises one branch, leaving the other uncovered (< 100%).
      const partial = `import { it, expect } from "vitest";
import { f } from "${SOURCE_IMPORT}";
it("f", () => { expect(f(2)).toBe(4); });
`;
      const run = await runTests({
        dir: path.join(dir, "cov"),
        sourceCode: "export function f(n: number): number {\n  if (n > 0) return n * 2;\n  return -1;\n}\n",
        testSource: partial,
        timeoutMs: 60_000,
        collectCoverage: true,
      });
      expect(run.passed).toBe(true);
      expect(run.coveragePct).not.toBeNull();
      expect(run.coveragePct!).toBeLessThan(100);
      expect(run.coveragePct!).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("quality gates (engine end-to-end)", () => {
  it("fails an item whose code does not type-check, after rework", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "1", MAX_REWORK_ATTEMPTS: "1" });
      config.gates.typecheck = true;
      // Tests pass but the module has a type error -> typecheck gate fails.
      const badSource = "export function f(n: number): number { const s: string = n; return n * 2; }\n";
      const pipeline = createPipeline({ config, agents: oneItemAgents(badSource), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const records = await pipeline.run("typecheck gate");
      expect(records[0]!.passed).toBe(false);
      const gateEvents = events.filter((e) => e.type === "item.gate");
      expect(gateEvents.some((e) => e.type === "item.gate" && e.gate === "tests" && e.passed)).toBe(true);
      expect(gateEvents.some((e) => e.type === "item.gate" && e.gate === "typecheck" && !e.passed)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("passes an item that clears all gates", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "1" });
      config.gates.typecheck = true;
      config.gates.lint = true;
      config.gates.coverage = true;
      config.gates.coverageMin = 50;
      const goodSource = "export function f(n: number): number { return n * 2; }\n";
      const pipeline = createPipeline({ config, agents: oneItemAgents(goodSource), workspaceDir: dir });
      const records = await pipeline.run("all gates");
      expect(records[0]!.passed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
