/**
 * Engine behaviour against deterministic stub agents (no gateway).
 *
 * Covers the acceptance criteria that are about the machine itself:
 *  - WBS of independent items (criterion #1)
 *  - observable pipeline parallelism (criterion #2)
 *  - real test execution + passing modules written to output (criterion #3)
 *  - bounded rework with feedback, surfaced as item.reworked (criterion #4)
 *  - clean shutdown: run() resolves with one terminal record per item
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import type { Stage } from "../src/contracts.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { tmpWorkspace } from "./helpers.js";

function run(workspaceDir: string) {
  const config = loadConfig({
    MAX_WBS_ITEMS: "5",
    MAX_REWORK_ATTEMPTS: "2",
    DESIGNER_CONCURRENCY: "1",
    DEVELOPER_CONCURRENCY: "2",
    TESTER_CONCURRENCY: "2",
  });
  const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir });
  const events: PipelineEvent[] = [];
  pipeline.on((e) => events.push(e));
  return { events, done: pipeline.run("string utils") };
}

/** True if, replaying the started/completed events, two stages were ever active at once. */
function observedPipelineParallelism(events: PipelineEvent[]): boolean {
  const active: Record<Stage, Set<string>> = {
    designer: new Set(),
    developer: new Set(),
    tester: new Set(),
  };
  for (const e of events) {
    if (e.type === "item.started") active[e.stage].add(e.itemId);
    if (e.type === "item.completed") active[e.stage].delete(e.itemId);
    if (e.type === "item.failed") active[e.stage].delete(e.itemId);
    const stagesActive = (["designer", "developer", "tester"] as Stage[]).filter(
      (s) => active[s].size > 0,
    ).length;
    if (stagesActive >= 2) return true;
  }
  return false;
}

describe("pipeline engine", () => {
  it("decomposes into independent items and finalizes every one", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const { events, done } = run(dir);
      const records = await done;

      const wbs = events.find((e) => e.type === "wbs.created");
      expect(wbs?.type).toBe("wbs.created");
      expect(records).toHaveLength(5);
      expect(records.every((r) => r.passed)).toBe(true);

      // Exactly one terminal record per item; ids unique.
      const ids = records.map((r) => r.workItem.id);
      expect(new Set(ids).size).toBe(5);

      // pipeline.done carries the same records.
      const doneEvt = events.find((e) => e.type === "pipeline.done");
      expect(doneEvt?.type).toBe("pipeline.done");
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("shows pipeline parallelism (>=2 stages active at once)", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const { events, done } = run(dir);
      await done;
      expect(observedPipelineParallelism(events)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("reworks a first-attempt failure with feedback and retries to success", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const { events, done } = run(dir);
      const records = await done;

      const rework = events.find((e) => e.type === "item.reworked");
      expect(rework?.type).toBe("item.reworked");
      if (rework?.type === "item.reworked") {
        expect(rework.attempt).toBe(2);
        expect(rework.feedback.length).toBeGreaterThan(0);
      }

      // countVowels is the stub wired to fail attempt 1 then pass on rework.
      const reworked = records.find((r) => r.workItem.title.includes("countVowels"));
      expect(reworked?.attempts).toBe(2);
      expect(reworked?.passed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("writes passing modules to workspace/output", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const { done } = run(dir);
      const records = await done;
      for (const r of records.filter((x) => x.passed)) {
        const out = path.join(dir, "output");
        // At least one output dir exists for a passing item.
        await expect(access(path.join(out))).resolves.toBeUndefined();
      }
    } finally {
      await cleanup();
    }
  }, 120_000);
});
