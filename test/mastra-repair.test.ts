/**
 * The structured-output "repair" retry in the Mastra bridge (§one-repair scope).
 *
 * A malformed LLM response must get exactly ONE corrective re-ask before failing.
 * These tests never hit the network: the Mastra Agent is faked with a `generate`
 * method whose per-call results we control, cast to the Agent type.
 */
import type { Agent } from "@mastra/core/agent";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "../src/agents/mastra.js";

const schema = z.object({ name: z.string(), count: z.number() });

/** Build a fake Agent whose `generate` returns the queued `{ object }` results in order. */
function fakeAgent(objects: unknown[]) {
  const generate = vi.fn(async (_prompt: string, _opts?: unknown) => {
    const object = objects.shift();
    return { object };
  });
  const agent = { generate } as unknown as Agent;
  return { agent, generate };
}

describe("generateStructured repair retry", () => {
  it("repairs once when the first response is malformed", async () => {
    // First call missing `count` (parse fails), second call is valid.
    const { agent, generate } = fakeAgent([
      { name: "x" },
      { name: "x", count: 3 },
    ]);

    const result = await generateStructured(agent, "do the thing", schema);

    expect(result).toEqual({ name: "x", count: 3 });
    expect(generate).toHaveBeenCalledTimes(2);

    const secondCall = generate.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondPrompt = secondCall![0];
    expect(secondPrompt).toMatch(/schema|validation/i);
    // The repair prompt must surface the previous (failed) output to the model.
    expect(secondPrompt).toContain('{"name":"x"}');
  });

  it("does not repair when the first response is valid", async () => {
    const { agent, generate } = fakeAgent([{ name: "y", count: 7 }]);

    const result = await generateStructured(agent, "do the thing", schema);

    expect(result).toEqual({ name: "y", count: 7 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("throws when both the original and the repair fail validation", async () => {
    const { agent, generate } = fakeAgent([{ name: "x" }, { count: 1 }]);

    await expect(
      generateStructured(agent, "do the thing", schema),
    ).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
