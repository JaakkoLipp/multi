/**
 * The typed event stream — the load-bearing seam between the headless engine
 * and any renderer.
 *
 * Every PipelineEvent is plain JSON data. In phase 2 the webview bridge is
 * literally `engine.on(e => panel.webview.postMessage(e))` with no transform,
 * so nothing here may contain a class instance, function, Date, Map, Set, Error,
 * or an `undefined`-bearing field. Errors cross as strings.
 *
 * This module is part of the engine: it imports nothing from `vscode` and
 * nothing CLI-only.
 */
import type { FinalRecord, Stage, WorkItem } from "./contracts.js";

export type PipelineEvent =
  | { type: "pipeline.started"; runId: string; prompt: string; startedAt: number }
  | { type: "wbs.created"; items: WorkItem[] }
  | { type: "item.blocked"; itemId: string; dependsOn: string[] }
  | { type: "item.unblocked"; itemId: string }
  | { type: "item.enqueued"; stage: Stage; itemId: string; queueDepth: number }
  | { type: "item.started"; stage: Stage; itemId: string; worker: number }
  | { type: "item.completed"; stage: Stage; itemId: string; worker: number }
  | { type: "item.reworked"; itemId: string; attempt: number; feedback: string }
  | {
      type: "item.gate";
      itemId: string;
      gate: "tests" | "typecheck" | "lint" | "coverage";
      passed: boolean;
      detail: string;
    }
  | { type: "item.failed"; itemId: string; stage: Stage; error: string }
  | { type: "item.metrics"; stage: Stage; itemId: string; attempt: number; durationMs: number }
  | { type: "item.finalized"; record: FinalRecord }
  | { type: "pipeline.cancelled"; reason: string }
  | { type: "pipeline.done"; records: FinalRecord[] };

export type PipelineEventType = PipelineEvent["type"];

export type EventListener = (event: PipelineEvent) => void;

/**
 * A tiny synchronous typed emitter plus an async-iterable bridge.
 *
 * Kept deliberately dependency-free and headless. A listener throwing must not
 * take down the engine, so emit() isolates listener errors.
 */
export class EventBus {
  private listeners = new Set<EventListener>();
  private iteratorPushers = new Set<(e: PipelineEvent) => void>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PipelineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving renderer must never crash the engine. Swallow and move on.
      }
    }
    for (const push of this.iteratorPushers) push(event);
  }

  /**
   * Async-iterable view of the stream, terminating after `pipeline.done`.
   * Lets consumers do `for await (const e of bus.events()) { ... }`.
   */
  async *events(): AsyncGenerator<PipelineEvent> {
    const queue: PipelineEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const push = (e: PipelineEvent) => {
      queue.push(e);
      if (e.type === "pipeline.done") done = true;
      resolve?.();
      resolve = null;
    };
    this.iteratorPushers.add(push);

    try {
      while (true) {
        if (queue.length === 0) {
          if (done) return;
          await new Promise<void>((r) => (resolve = r));
        }
        while (queue.length > 0) {
          const next = queue.shift()!;
          yield next;
          if (next.type === "pipeline.done") return;
        }
      }
    } finally {
      this.iteratorPushers.delete(push);
    }
  }
}
