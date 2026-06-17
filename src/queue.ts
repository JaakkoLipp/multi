/**
 * D2 — Queue + concurrency primitive (hand-rolled).
 *
 * Why hand-rolled instead of p-queue: the pipeline is an assembly line of
 * long-lived workers, not a set of fire-and-forget tasks. We need three things
 * p-queue's task model does not give cleanly:
 *   1. N long-lived workers per stage that block-wait on an async pull.
 *   2. The tester re-enqueuing into the developer queue *after* a queue may have
 *      already drained — without that re-enqueue deadlocking or being lost.
 *   3. A global "all items reached a terminal state" latch so the engine can
 *      stop every worker and resolve run() cleanly.
 *
 * AsyncQueue is an unbounded MPMC queue: push() never blocks, pull() resolves
 * when an item is available or the queue is closed (returning CLOSED).
 */

export const CLOSED = Symbol("queue-closed");
export type Closed = typeof CLOSED;

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | Closed) => void> = [];
  private closed = false;

  get depth(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.closed) throw new Error("push on closed queue");
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Resolves with the next item, or CLOSED once the queue is closed and drained. */
  pull(): Promise<T | Closed> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(CLOSED);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Wake every blocked puller with CLOSED. Items already queued are dropped. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter(CLOSED);
    this.waiters = [];
  }
}

/**
 * A pool of `concurrency` long-lived workers draining a queue. Each worker loops
 * pull -> handle -> repeat until the queue closes. A handler throwing for one
 * item must not kill the worker (the engine turns failures into events), so we
 * isolate per-item errors here as a last-resort safety net.
 */
export class WorkerPool<T> {
  private running: Promise<void>[] = [];

  constructor(
    private readonly queue: AsyncQueue<T>,
    private readonly concurrency: number,
    private readonly handle: (item: T, worker: number) => Promise<void>,
  ) {}

  start(): void {
    for (let w = 0; w < this.concurrency; w++) {
      this.running.push(this.loop(w));
    }
  }

  private async loop(worker: number): Promise<void> {
    while (true) {
      const item = await this.queue.pull();
      if (item === CLOSED) return;
      try {
        await this.handle(item, worker);
      } catch {
        // Last-resort guard; stage handlers are expected to handle their own
        // errors and emit events. Keep the worker alive regardless.
      }
    }
  }

  /** Resolves once all workers have observed the queue closing and exited. */
  async drained(): Promise<void> {
    await Promise.all(this.running);
  }
}

/**
 * Tracks how many items are still "in flight" (not yet terminal) across the
 * whole pipeline and fires once that count hits zero. The engine increments on
 * WBS creation and on every re-enqueue-as-new-attempt is NOT a new item, so the
 * counter is keyed to *work items*, not queue hops: it starts at len(WBS) and
 * decrements once per item when that item is finalized.
 */
export class CompletionLatch {
  private remaining: number;
  private resolveAll!: () => void;
  readonly done: Promise<void>;

  constructor(total: number) {
    this.remaining = total;
    this.done = new Promise<void>((resolve) => (this.resolveAll = resolve));
    if (total === 0) this.resolveAll();
  }

  settleOne(): void {
    this.remaining -= 1;
    if (this.remaining <= 0) this.resolveAll();
  }
}
