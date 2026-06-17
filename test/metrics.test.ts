/**
 * The run summary is a pure fold over the event stream — same property the
 * renderers rely on. We verify it against a real stub run and against a
 * hand-built stream (including cancellation).
 */
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { summarize } from "../src/metrics.js";
import { tmpWorkspace } from "./helpers.js";

describe("summarize", () => {
  it("aggregates a real run's stream", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "5" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));
      const records = await pipeline.run("string utils");

      const s = summarize(events);
      expect(s.runId).not.toBeNull();
      expect(s.prompt).toBe("string utils");
      expect(s.total).toBe(5);
      expect(s.passed + s.failed).toBe(5);
      expect(s.passed).toBe(records.filter((r) => r.passed).length);
      expect(s.reworks).toBeGreaterThanOrEqual(1); // countVowels round-trips
      expect(s.items).toHaveLength(5);

      // Every stage ran; busyMs is the sum of all stage durations.
      expect(s.perStage.designer.runs).toBeGreaterThan(0);
      expect(s.perStage.developer.runs).toBeGreaterThanOrEqual(5);
      expect(s.perStage.tester.runs).toBeGreaterThanOrEqual(5);
      const stageTotal =
        s.perStage.designer.totalMs + s.perStage.developer.totalMs + s.perStage.tester.totalMs;
      expect(s.busyMs).toBe(stageTotal);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("records cancellation", () => {
    const events: PipelineEvent[] = [
      { type: "pipeline.started", runId: "r1", prompt: "p", startedAt: 0 },
      { type: "wbs.created", items: [] },
      { type: "pipeline.cancelled", reason: "interrupted" },
      { type: "pipeline.done", records: [] },
    ];
    const s = summarize(events);
    expect(s.cancelled).toBe(true);
    expect(s.cancelReason).toBe("interrupted");
  });
});
