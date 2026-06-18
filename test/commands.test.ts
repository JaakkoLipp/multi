/**
 * The inbound command channel must be as serializable as the outbound event
 * stream — it crosses the same phase-2 webview boundary, just in the other
 * direction (webview.onDidReceiveMessage -> pipeline.send). We check every
 * command variant round-trips through JSON, and that run.cancel via send() is
 * behaviourally identical to the AbortSignal cancellation path.
 */
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { CommandBus, type PipelineCommand, type PipelineCommandType } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { tmpWorkspace } from "./helpers.js";

const samples: Record<PipelineCommandType, PipelineCommand> = {
  "run.cancel": { type: "run.cancel", reason: "stop" },
  "pipeline.pause": { type: "pipeline.pause" },
  "pipeline.resume": { type: "pipeline.resume" },
  "item.cancel": { type: "item.cancel", itemId: "wi-001", reason: "not needed" },
  "item.retry": { type: "item.retry", itemId: "wi-001" },
  "item.reprioritize": { type: "item.reprioritize", itemId: "wi-001", priority: 5 },
};

describe("PipelineCommand serialization", () => {
  it("round-trips every command variant unchanged", () => {
    for (const cmd of Object.values(samples)) {
      const clone = JSON.parse(JSON.stringify(cmd));
      expect(clone).toEqual(cmd);
      expect(JSON.stringify(clone)).toBe(JSON.stringify(cmd));
      expect(JSON.stringify(cmd)).not.toContain("undefined");
    }
  });

  it("covers the whole command union", () => {
    const expected: PipelineCommandType[] = [
      "run.cancel",
      "pipeline.pause",
      "pipeline.resume",
      "item.cancel",
      "item.retry",
      "item.reprioritize",
    ];
    expect(Object.keys(samples).sort()).toEqual([...expected].sort());
  });
});

describe("command channel — run.cancel", () => {
  it("cancels a live run via pipeline.send, like AbortSignal", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "5" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const done = pipeline.run("string utils");
      setTimeout(() => pipeline.send({ type: "run.cancel", reason: "stop" }), 40);

      const records = await done; // must resolve, not hang
      expect(records).toHaveLength(5);
      expect(events.some((e) => e.type === "pipeline.cancelled" && e.reason === "stop")).toBe(true);
      expect(records.some((r) => !r.passed && r.lastError === "cancelled")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("acknowledges unsupported commands as command.rejected", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const bus = new CommandBus();
      const config = loadConfig({ MAX_WBS_ITEMS: "2" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir, commands: bus });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      // Fire an unsupported command shortly after the run starts.
      const done = pipeline.run("string utils");
      setTimeout(() => bus.send({ type: "item.reprioritize", itemId: "wi-001", priority: 1 }), 20);
      await done;

      expect(events.some((e) => e.type === "command.rejected" && e.command === "item.reprioritize")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
