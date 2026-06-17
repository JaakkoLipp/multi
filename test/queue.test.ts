/**
 * Unit tests for the concurrency primitive (D2): the parts the engine relies on
 * for the rework re-enqueue and clean shutdown.
 */
import { describe, expect, it } from "vitest";
import { AsyncQueue, CLOSED, CompletionLatch } from "../src/queue.js";

describe("AsyncQueue", () => {
  it("delivers a value pushed before a pull", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    expect(await q.pull()).toBe(1);
  });

  it("resolves a pull that was waiting when a value arrives (back-edge case)", async () => {
    const q = new AsyncQueue<string>();
    const pending = q.pull();
    q.push("late"); // e.g. tester re-enqueuing after the queue had drained
    expect(await pending).toBe("late");
  });

  it("wakes blocked pullers with CLOSED on close (clean shutdown)", async () => {
    const q = new AsyncQueue<number>();
    const a = q.pull();
    const b = q.pull();
    q.close();
    expect(await a).toBe(CLOSED);
    expect(await b).toBe(CLOSED);
  });

  it("tracks depth", () => {
    const q = new AsyncQueue<number>();
    expect(q.depth).toBe(0);
    q.push(1);
    q.push(2);
    expect(q.depth).toBe(2);
  });
});

describe("CompletionLatch", () => {
  it("resolves after the expected number of settlements", async () => {
    const latch = new CompletionLatch(2);
    let resolved = false;
    void latch.done.then(() => (resolved = true));
    latch.settleOne();
    await Promise.resolve();
    expect(resolved).toBe(false);
    latch.settleOne();
    await latch.done;
    expect(resolved).toBe(true);
  });

  it("resolves immediately for an empty WBS", async () => {
    await expect(new CompletionLatch(0).done).resolves.toBeUndefined();
  });
});
