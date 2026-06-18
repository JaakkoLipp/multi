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
  dependsOn: [],
};

const sampleRecord: FinalRecord = {
  workItem: sampleItem,
  passed: true,
  attempts: 2,
  sourceCode: "export const x = 1;",
  testSource: "test code",
  lastError: null,
  patch: null,
};

const samples: Record<PipelineEventType, PipelineEvent> = {
  "pipeline.started": { type: "pipeline.started", runId: "2026-06-16", prompt: "string utils", startedAt: 1750000000000 },
  "wbs.created": { type: "wbs.created", items: [sampleItem] },
  "item.blocked": { type: "item.blocked", itemId: "wi-002", dependsOn: ["wi-001"] },
  "item.unblocked": { type: "item.unblocked", itemId: "wi-002" },
  "item.enqueued": { type: "item.enqueued", stage: "designer", itemId: "wi-001", queueDepth: 3 },
  "item.started": { type: "item.started", stage: "developer", itemId: "wi-001", worker: 0 },
  "item.completed": { type: "item.completed", stage: "tester", itemId: "wi-001", worker: 1 },
  "item.reworked": { type: "item.reworked", itemId: "wi-001", attempt: 2, feedback: "boom" },
  "item.reviewed": { type: "item.reviewed", itemId: "wi-001", attempt: 1, approved: false, notes: "fix edge case" },
  "item.gate": { type: "item.gate", itemId: "wi-001", gate: "coverage", passed: false, detail: "60% (min 80%)" },
  "item.failed": { type: "item.failed", itemId: "wi-001", stage: "tester", error: "nope" },
  "item.metrics": { type: "item.metrics", stage: "developer", itemId: "wi-001", attempt: 1, durationMs: 42 },
  "item.finalized": { type: "item.finalized", record: sampleRecord },
  "pipeline.paused": { type: "pipeline.paused", at: 1750000000000 },
  "pipeline.resumed": { type: "pipeline.resumed", at: 1750000000001 },
  "item.skipped": { type: "item.skipped", itemId: "wi-001", reason: "skipped by user" },
  "item.retry.accepted": { type: "item.retry.accepted", itemId: "wi-001", attempt: 3 },
  "command.rejected": { type: "command.rejected", command: "item.retry", itemId: "wi-001", reason: "already finalized" },
  "pipeline.cancelled": { type: "pipeline.cancelled", reason: "interrupted by user (SIGINT)" },
  "pipeline.packaged": { type: "pipeline.packaged", dir: "/tmp/pkg", modules: ["slugify"], integrationPassed: true },
  "repo.acquired": { type: "repo.acquired", runId: "2026-06-16", root: "/tmp/wc", ref: "main" },
  "item.patch.proposed": { type: "item.patch.proposed", itemId: "wi-001", attempt: 1, files: ["src.mjs"], summary: "fix add" },
  "item.patch.applied": { type: "item.patch.applied", itemId: "wi-001", attempt: 1, files: ["src.mjs"] },
  "item.command": { type: "item.command", itemId: "wi-001", command: "node test.mjs", passed: true, detail: "ok" },
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
      "pipeline.started",
      "wbs.created",
      "item.blocked",
      "item.unblocked",
      "item.enqueued",
      "item.started",
      "item.completed",
      "item.reworked",
      "item.reviewed",
      "item.gate",
      "item.failed",
      "item.metrics",
      "item.finalized",
      "pipeline.paused",
      "pipeline.resumed",
      "item.skipped",
      "item.retry.accepted",
      "command.rejected",
      "pipeline.cancelled",
      "pipeline.packaged",
      "repo.acquired",
      "item.patch.proposed",
      "item.patch.applied",
      "item.command",
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
