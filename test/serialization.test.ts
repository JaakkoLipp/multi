/**
 * Extension-readiness, verified not just intended (acceptance criterion #7).
 *
 * Every PipelineEvent must survive JSON.parse(JSON.stringify(event)) UNCHANGED —
 * this is exactly the postMessage boundary the phase-2 webview will cross. We
 * check both a hand-built sample of every variant AND every event actually
 * emitted by a real stub run.
 */
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import type { FinalRecord, WorkItem } from "../src/contracts.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent, PipelineEventType } from "../src/events.js";
import { tmpWorkspace } from "./helpers.js";

const sampleItem: WorkItem = {
  id: "wi-001",
  title: "slugify utility",
  description: "Implement slugify",
  acceptanceCriteria: ["empty string"],
};

const sampleRecord: FinalRecord = {
  workItem: sampleItem,
  passed: true,
  attempts: 2,
  sourceCode: "export const x = 1;",
  testSource: "test code",
  lastError: null,
};

const samples: Record<PipelineEventType, PipelineEvent> = {
  "wbs.created": { type: "wbs.created", items: [sampleItem] },
  "item.enqueued": { type: "item.enqueued", stage: "designer", itemId: "wi-001", queueDepth: 3 },
  "item.started": { type: "item.started", stage: "developer", itemId: "wi-001", worker: 0 },
  "item.completed": { type: "item.completed", stage: "tester", itemId: "wi-001", worker: 1 },
  "item.reworked": { type: "item.reworked", itemId: "wi-001", attempt: 2, feedback: "boom" },
  "item.failed": { type: "item.failed", itemId: "wi-001", stage: "tester", error: "nope" },
  "item.finalized": { type: "item.finalized", record: sampleRecord },
  "pipeline.done": { type: "pipeline.done", records: [sampleRecord] },
};

function assertRoundTrips(event: PipelineEvent): void {
  const clone = JSON.parse(JSON.stringify(event));
  // Deep-equal AND structurally identical: catches Date/Map/Set/undefined/class
  // instances, all of which would diverge under JSON round-tripping.
  expect(clone).toEqual(event);
  expect(JSON.stringify(clone)).toBe(JSON.stringify(event));
}

describe("PipelineEvent serialization", () => {
  it("round-trips every event variant unchanged", () => {
    for (const event of Object.values(samples)) {
      assertRoundTrips(event);
      expect(JSON.stringify(event)).not.toContain("undefined");
    }
  });

  it("covers the whole union (no variant forgotten)", () => {
    const expected: PipelineEventType[] = [
      "wbs.created",
      "item.enqueued",
      "item.started",
      "item.completed",
      "item.reworked",
      "item.failed",
      "item.finalized",
      "pipeline.done",
    ];
    expect(Object.keys(samples).sort()).toEqual([...expected].sort());
  });

  it("round-trips every event emitted by a real run", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "3" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const seen: PipelineEvent[] = [];
      pipeline.on((e) => seen.push(e));
      await pipeline.run("string utils");

      expect(seen.length).toBeGreaterThan(0);
      for (const e of seen) assertRoundTrips(e);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
