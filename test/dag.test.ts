/**
 * Dependency-aware scheduling (DAG): items are admitted only once their
 * dependencies pass, dependents of a failed item are cascade-failed without
 * running, and a cyclic graph is rejected up front.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CodeOutput, DesignOutput, TestOutput, WbsOutput } from "../src/contracts.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { SOURCE_IMPORT } from "../src/sandbox.js";
import type { Agents, DesignInput, DevelopInput, WriteTestsInput } from "../src/agents/types.js";
import { tmpWorkspace } from "./helpers.js";

/**
 * A configurable agent bundle: a chain a -> b -> c (each depends on the prior),
 * where `failing` names the function whose generated test never passes.
 */
function chainAgents(failing: string | null): Agents {
  const fnFor = (title: string) => title.trim().toLowerCase();
  return {
    async orchestrate(): Promise<WbsOutput> {
      return {
        items: [
          { key: "a", title: "a", description: "fn a", acceptanceCriteria: ["ok"], dependsOn: [] },
          { key: "b", title: "b", description: "fn b", acceptanceCriteria: ["ok"], dependsOn: ["a"] },
          { key: "c", title: "c", description: "fn c", acceptanceCriteria: ["ok"], dependsOn: ["b"] },
        ],
      };
    },
    async design({ item }: DesignInput): Promise<DesignOutput> {
      const name = fnFor(item.title);
      return {
        functionName: name,
        signature: `export function ${name}(): number`,
        behavior: "returns 1",
        edgeCases: [],
        examples: [],
      };
    },
    async develop(input: DevelopInput): Promise<CodeOutput> {
      const name = input.spec.functionName;
      return { functionName: name, sourceCode: `export function ${name}(): number { return 1; }\n` };
    },
    async writeTests(input: WriteTestsInput): Promise<TestOutput> {
      const name = input.functionName;
      const expected = name === failing ? 2 : 1; // failing fn asserts the wrong value
      return {
        testSource: `import { it, expect } from "vitest";
import { ${name} } from "${SOURCE_IMPORT}";
it("${name}", () => { expect(${name}()).toBe(${expected}); });
`,
      };
    },
  };
}

describe("DAG scheduling", () => {
  it("admits dependents only after their dependency passes", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "3", DEVELOPER_CONCURRENCY: "2", TESTER_CONCURRENCY: "2" });
      const pipeline = createPipeline({ config, agents: chainAgents(null), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const records = await pipeline.run("chain");
      expect(records.every((r) => r.passed)).toBe(true);

      // b and c start blocked; both get unblocked exactly once.
      const blocked = events.filter((e) => e.type === "item.blocked").map((e) => (e as { itemId: string }).itemId);
      expect(blocked.sort()).toEqual(["wi-002", "wi-003"]);
      const unblocked = events.filter((e) => e.type === "item.unblocked").map((e) => (e as { itemId: string }).itemId);
      expect(unblocked.sort()).toEqual(["wi-002", "wi-003"]);

      // Ordering: a finalizes before b's designer starts; b before c.
      const finalizedAt = (id: string) =>
        events.findIndex((e) => e.type === "item.finalized" && e.record.workItem.id === id);
      const designStartAt = (id: string) =>
        events.findIndex((e) => e.type === "item.started" && e.stage === "designer" && e.itemId === id);
      expect(finalizedAt("wi-001")).toBeLessThan(designStartAt("wi-002"));
      expect(finalizedAt("wi-002")).toBeLessThan(designStartAt("wi-003"));
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("cascade-fails dependents when a dependency does not pass", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "3", MAX_REWORK_ATTEMPTS: "1" });
      const pipeline = createPipeline({ config, agents: chainAgents("a"), workspaceDir: dir });
      const records = await pipeline.run("chain");

      const byId = new Map(records.map((r) => [r.workItem.id, r]));
      expect(byId.get("wi-001")!.passed).toBe(false); // root failed its tests
      expect(byId.get("wi-002")!.passed).toBe(false);
      expect(byId.get("wi-003")!.passed).toBe(false);
      expect(byId.get("wi-002")!.lastError).toMatch(/blocked: dependency wi-001/);
      expect(byId.get("wi-003")!.lastError).toMatch(/blocked: dependency wi-002/);
      // Dependents never ran the developer stage.
      expect(byId.get("wi-002")!.sourceCode).toBeNull();
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("rejects a cyclic dependency graph", async () => {
    const cyclic: Agents = {
      ...chainAgents(null),
      async orchestrate(): Promise<WbsOutput> {
        return {
          items: [
            { key: "a", title: "a", description: "", acceptanceCriteria: ["ok"], dependsOn: ["b"] },
            { key: "b", title: "b", description: "", acceptanceCriteria: ["ok"], dependsOn: ["a"] },
          ],
        };
      },
    };
    const pipeline = createPipeline({ config: loadConfig({}), agents: cyclic });
    await expect(pipeline.run("cycle")).rejects.toThrow(/cycle/i);
  });
});
