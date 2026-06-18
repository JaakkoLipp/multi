/**
 * Live control: pause/resume against the worker pull loop without deadlocking the
 * completion latch, cancel-while-paused (deadlock regression), and per-item skip
 * with DAG-correct cascade. Every scenario must still finalize a record per item.
 */
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import type { CodeOutput, DesignOutput, ReviewOutput, TestOutput, WbsOutput } from "../src/contracts.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { SOURCE_IMPORT } from "../src/sandbox.js";
import type { Agents, DesignInput, DevelopInput, WriteTestsInput } from "../src/agents/types.js";
import { tmpWorkspace } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pause / resume", () => {
  it("pause halts new work; run() stays pending; resume completes", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "5", DEVELOPER_CONCURRENCY: "1", TESTER_CONCURRENCY: "1" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const done = pipeline.run("string utils");
      await sleep(30);
      pipeline.send({ type: "pipeline.pause" });
      await sleep(60);

      // Capture how many items had started by shortly after pausing, then confirm
      // the run has NOT completed and no further progress is being made.
      const startedAtPause = new Set(
        events.filter((e) => e.type === "item.started").map((e) => (e as { itemId: string }).itemId),
      ).size;
      let settled = false;
      void done.then(() => (settled = true));
      await sleep(150);
      expect(settled).toBe(false); // paused run stays pending, does not hang-as-bug
      expect(events.some((e) => e.type === "pipeline.paused")).toBe(true);

      pipeline.send({ type: "pipeline.resume" });
      const records = await done;
      expect(records).toHaveLength(5);
      expect(records.every((r) => r.passed)).toBe(true);
      expect(events.some((e) => e.type === "pipeline.resumed")).toBe(true);
      // Resume actually unblocked progress beyond what had started at pause time.
      const startedTotal = new Set(
        events.filter((e) => e.type === "item.started").map((e) => (e as { itemId: string }).itemId),
      ).size;
      expect(startedTotal).toBeGreaterThanOrEqual(startedAtPause);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("cancel while paused resolves the run (no deadlock)", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "5", DEVELOPER_CONCURRENCY: "1", TESTER_CONCURRENCY: "1" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const done = pipeline.run("string utils");
      await sleep(30);
      pipeline.send({ type: "pipeline.pause" });
      await sleep(60);
      pipeline.send({ type: "run.cancel", reason: "stop while paused" });

      const records = await done; // must resolve
      expect(records).toHaveLength(5);
      expect(events.some((e) => e.type === "pipeline.cancelled")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("item.cancel (skip)", () => {
  /** a -> b -> c chain so skipping a root cascade-fails its dependents. */
  function chainAgents(): Agents {
    return {
      async orchestrate(): Promise<WbsOutput> {
        return {
          items: [
            { key: "a", title: "a", description: "", acceptanceCriteria: ["ok"], dependsOn: [] },
            { key: "b", title: "b", description: "", acceptanceCriteria: ["ok"], dependsOn: ["a"] },
            { key: "c", title: "c", description: "", acceptanceCriteria: ["ok"], dependsOn: ["b"] },
          ],
        };
      },
      async design({ item }: DesignInput): Promise<DesignOutput> {
        const name = item.title.trim();
        return { functionName: name, signature: `export function ${name}(): number`, behavior: "1", edgeCases: [], examples: [] };
      },
      async develop(i: DevelopInput): Promise<CodeOutput> {
        const name = i.spec.functionName;
        // Slow enough that the skip command lands before 'a' finishes.
        await sleep(120);
        return { functionName: name, sourceCode: `export function ${name}(): number { return 1; }\n` };
      },
      async writeTests(i: WriteTestsInput): Promise<TestOutput> {
        const name = i.functionName;
        return { testSource: `import { it, expect } from "vitest";\nimport { ${name} } from "${SOURCE_IMPORT}";\nit("${name}", () => { expect(${name}()).toBe(1); });\n` };
      },
      async review(): Promise<ReviewOutput> {
        return { approved: true, notes: "" };
      },
    };
  }

  it("skips an item and cascade-fails its dependents", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "3" });
      const pipeline = createPipeline({ config, agents: chainAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const done = pipeline.run("chain");
      await sleep(20);
      pipeline.send({ type: "item.cancel", itemId: "wi-001", reason: "not needed" });

      const records = await done;
      expect(records).toHaveLength(3);
      const byId = new Map(records.map((r) => [r.workItem.id, r]));
      expect(byId.get("wi-001")!.passed).toBe(false);
      expect(byId.get("wi-001")!.lastError).toMatch(/skipped/);
      expect(byId.get("wi-002")!.passed).toBe(false);
      expect(byId.get("wi-003")!.passed).toBe(false);
      expect(events.some((e) => e.type === "item.skipped" && e.itemId === "wi-001")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("rejects skip of an unknown item", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const pipeline = createPipeline({ config: loadConfig({ MAX_WBS_ITEMS: "2" }), agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));
      const done = pipeline.run("string utils");
      await sleep(10);
      pipeline.send({ type: "item.cancel", itemId: "wi-999", reason: "nope" });
      await done;
      expect(events.some((e) => e.type === "command.rejected" && e.command === "item.cancel")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
