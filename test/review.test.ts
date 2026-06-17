/**
 * Design/code review loop: an enabled critic reviews the developer's code before
 * testing. A rejection reuses the rework edge (re-enqueue to the developer) and
 * is surfaced as item.reviewed; an exhausted budget falls through to the tester.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CodeOutput, DesignOutput, ReviewOutput, TestOutput, WbsOutput } from "../src/contracts.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { SOURCE_IMPORT } from "../src/sandbox.js";
import type {
  Agents,
  DesignInput,
  DevelopInput,
  ReviewInput,
  WriteTestsInput,
} from "../src/agents/types.js";
import { tmpWorkspace } from "./helpers.js";

const PASS_TEST = `import { it, expect } from "vitest";
import { f } from "${SOURCE_IMPORT}";
it("f", () => { expect(f()).toBe(1); });
`;

/** One-item agents whose critic rejects until `approveFromAttempt`. */
function reviewingAgents(approveFromAttempt: number): { agents: Agents; reviews: number[] } {
  const reviews: number[] = [];
  const agents: Agents = {
    async orchestrate(): Promise<WbsOutput> {
      return { items: [{ key: "f", title: "f", description: "fn", acceptanceCriteria: ["ok"], dependsOn: [] }] };
    },
    async design(_i: DesignInput): Promise<DesignOutput> {
      return { functionName: "f", signature: "export function f(): number", behavior: "returns 1", edgeCases: [], examples: [] };
    },
    async develop(_i: DevelopInput): Promise<CodeOutput> {
      return { functionName: "f", sourceCode: "export function f(): number { return 1; }\n" };
    },
    async writeTests(_i: WriteTestsInput): Promise<TestOutput> {
      return { testSource: PASS_TEST };
    },
    async review(input: ReviewInput): Promise<ReviewOutput> {
      reviews.push(input.attempt);
      const approved = input.attempt >= approveFromAttempt;
      return { approved, notes: approved ? "" : `attempt ${input.attempt}: tighten the implementation` };
    },
  };
  return { agents, reviews };
}

describe("review loop", () => {
  it("reworks on rejection then proceeds once approved", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "1", MAX_REWORK_ATTEMPTS: "2" });
      config.review.enabled = true;
      const { agents, reviews } = reviewingAgents(2); // reject attempt 1, approve attempt 2
      const pipeline = createPipeline({ config, agents, workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      const records = await pipeline.run("review");
      expect(records[0]!.passed).toBe(true);
      expect(records[0]!.attempts).toBe(2); // ran the developer twice

      expect(reviews).toEqual([1, 2]);
      const reviewed = events.filter((e) => e.type === "item.reviewed");
      expect(reviewed.some((e) => e.type === "item.reviewed" && !e.approved)).toBe(true);
      expect(reviewed.some((e) => e.type === "item.reviewed" && e.approved)).toBe(true);
      // A rework was triggered by the critic, not the tester.
      expect(events.some((e) => e.type === "item.reworked")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("falls through to the tester when the review budget is exhausted", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "1", MAX_REWORK_ATTEMPTS: "1" });
      config.review.enabled = true;
      const { agents } = reviewingAgents(99); // always reject
      const pipeline = createPipeline({ config, agents, workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      // Tests still pass, so the item passes despite the critic never approving.
      const records = await pipeline.run("review");
      expect(records[0]!.passed).toBe(true);
      expect(events.some((e) => e.type === "item.started" && e.stage === "tester")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
