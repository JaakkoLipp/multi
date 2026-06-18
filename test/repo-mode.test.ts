/**
 * Repo execution mode through the full engine: createPipeline(mode:"repo") clones
 * the fixture into a per-item working copy, the stub repo-agents design + patch a
 * real bug, the tester applies the patch and runs the repo's OWN test command, and
 * the first (wrong) attempt round-trips back to the developer with the real
 * failing output before passing. Module mode is exercised by every other test and
 * is untouched.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { tmpWorkspace } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/repo", import.meta.url));

describe("repo execution mode", () => {
  it("fixes a real repo via patch + the repo's own tests, with rework", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({
        MODE: "repo",
        REPO_SOURCE: fixture,
        REPO_TEST_CMD: "node test.mjs",
        MAX_WBS_ITEMS: "1",
        MAX_REWORK_ATTEMPTS: "2",
      });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const records = await pipeline.run("Fix the add() bug");

      expect(records).toHaveLength(1);
      expect(records[0]!.passed).toBe(true);
      expect(records[0]!.attempts).toBe(2); // wrong first patch -> rework -> pass
      expect(records[0]!.patch).not.toBeNull();
      expect(records[0]!.patch!.edits[0]!.path).toBe("src.mjs");
      expect(records[0]!.sourceCode).toBeNull(); // repo mode produces a patch, not a module

      // Repo-mode events fired and round-trip as plain JSON.
      expect(events.some((e) => e.type === "repo.acquired")).toBe(true);
      expect(events.some((e) => e.type === "item.patch.applied")).toBe(true);
      const cmds = events.filter((e) => e.type === "item.command");
      expect(cmds.some((e) => e.type === "item.command" && !e.passed)).toBe(true); // attempt 1 failed
      expect(cmds.some((e) => e.type === "item.command" && e.passed)).toBe(true); // attempt 2 passed
      expect(events.some((e) => e.type === "item.reworked")).toBe(true);
      for (const e of events) expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("runs the setup command (e.g. install) on each working copy before tests", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({
        MODE: "repo",
        REPO_SOURCE: fixture,
        REPO_SETUP_CMD: "node -e process.exit(0)",
        REPO_TEST_CMD: "node test.mjs",
        MAX_WBS_ITEMS: "1",
        MAX_REWORK_ATTEMPTS: "2",
      });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const records = await pipeline.run("Fix the add() bug");
      expect(records[0]!.passed).toBe(true);
      // The setup command was executed and reported as an item.command.
      expect(
        events.some((e) => e.type === "item.command" && e.command.startsWith("node -e") && e.passed),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("fails the item when the setup command fails", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({
        MODE: "repo",
        REPO_SOURCE: fixture,
        REPO_SETUP_CMD: "node -e process.exit(1)",
        REPO_TEST_CMD: "node test.mjs",
        MAX_WBS_ITEMS: "1",
      });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const records = await pipeline.run("Fix the add() bug");
      expect(records[0]!.passed).toBe(false);
      expect(records[0]!.lastError).toMatch(/setup failed/i);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("cancels a repo run via command without hanging", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({
        MODE: "repo",
        REPO_SOURCE: fixture,
        REPO_TEST_CMD: "node test.mjs",
        MAX_WBS_ITEMS: "3",
      });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const done = pipeline.run("fix bugs");
      setTimeout(() => pipeline.send({ type: "run.cancel", reason: "stop" }), 20);
      const records = await done;
      expect(records).toHaveLength(3);
      expect(events.some((e) => e.type === "pipeline.cancelled")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
