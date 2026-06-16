/**
 * Terminal live view — the "understudy" for the phase-2 webview renderer.
 *
 * It attaches as a pure event subscriber (`pipeline.on`) and derives the ENTIRE
 * view — per-stage worker activity, queue depths, rework count, done/total —
 * from the event stream alone. It never calls into the engine. Removing it
 * changes nothing about pipeline behaviour. The webview will subscribe to the
 * exact same stream; only the output surface differs.
 */
import logUpdate from "log-update";
import pc from "picocolors";
import type { Stage } from "../contracts.js";
import type { PipelineEvent } from "../events.js";

const STAGES: Stage[] = ["designer", "developer", "tester"];

export interface StageView {
  depth: number;
  active: Set<string>;
}

export interface ViewState {
  total: number;
  done: number;
  passed: number;
  failed: number;
  reworks: number;
  busyMs: number;
  cancelled: boolean;
  stages: Record<Stage, StageView>;
  lastEvents: string[];
}

export function emptyState(): ViewState {
  return {
    total: 0,
    done: 0,
    passed: 0,
    failed: 0,
    reworks: 0,
    busyMs: 0,
    cancelled: false,
    stages: {
      designer: { depth: 0, active: new Set() },
      developer: { depth: 0, active: new Set() },
      tester: { depth: 0, active: new Set() },
    },
    lastEvents: [],
  };
}

export function reduce(state: ViewState, e: PipelineEvent): void {
  switch (e.type) {
    case "pipeline.started":
      note(state, `run ${e.runId} started`);
      break;
    case "wbs.created":
      state.total = e.items.length;
      note(state, `WBS created: ${e.items.length} items`);
      break;
    case "item.enqueued":
      state.stages[e.stage].depth = e.queueDepth;
      break;
    case "item.started":
      state.stages[e.stage].active.add(e.itemId);
      if (state.stages[e.stage].depth > 0) state.stages[e.stage].depth -= 1;
      break;
    case "item.completed":
      state.stages[e.stage].active.delete(e.itemId);
      break;
    case "item.reworked":
      state.reworks += 1;
      // The item leaves the tester back toward the developer queue.
      state.stages.tester.active.delete(e.itemId);
      note(state, `${e.itemId} reworked -> dev (attempt ${e.attempt})`);
      break;
    case "item.failed":
      state.stages[e.stage].active.delete(e.itemId);
      break;
    case "item.metrics":
      state.busyMs += e.durationMs;
      break;
    case "pipeline.cancelled":
      state.cancelled = true;
      note(state, pc.yellow(`cancelled: ${e.reason}`));
      break;
    case "item.finalized":
      state.done += 1;
      if (e.record.passed) state.passed += 1;
      else state.failed += 1;
      note(
        state,
        `${e.record.workItem.id} ${e.record.passed ? pc.green("PASS") : pc.red("FAIL")} (${e.record.attempts} attempt${e.record.attempts === 1 ? "" : "s"})`,
      );
      break;
    case "pipeline.done":
      break;
  }
}

function note(state: ViewState, line: string): void {
  state.lastEvents.push(line);
  if (state.lastEvents.length > 5) state.lastEvents.shift();
}

function render(state: ViewState): string {
  const header =
    pc.bold("Multi-agent pipeline") +
    pc.dim("  ·  ") +
    `done ${pc.bold(`${state.done}/${state.total}`)}` +
    pc.dim("  ·  ") +
    `${pc.green(String(state.passed))} pass ${pc.red(String(state.failed))} fail` +
    pc.dim("  ·  ") +
    `reworks ${pc.yellow(String(state.reworks))}` +
    pc.dim("  ·  ") +
    `busy ${pc.bold(`${(state.busyMs / 1000).toFixed(1)}s`)}` +
    (state.cancelled ? pc.dim("  ·  ") + pc.yellow("CANCELLED") : "");

  const rows = STAGES.map((stage) => {
    const v = state.stages[stage];
    const active = [...v.active];
    const dot = active.length > 0 ? pc.green("●") : pc.dim("○");
    const items = active.length > 0 ? active.map((i) => pc.cyan(i)).join(" ") : pc.dim("idle");
    return `  ${dot} ${pc.bold(stage.padEnd(9))} ${pc.dim(`q:${v.depth}`.padEnd(5))} ${items}`;
  });

  const recent = state.lastEvents.length
    ? [pc.dim("recent:"), ...state.lastEvents.map((l) => `  ${l}`)].join("\n")
    : "";

  return [header, "", ...rows, "", recent].join("\n");
}

/**
 * Fold an event sequence into a view state. Pure: the entire view is a function
 * of the stream and nothing else. This is what lets a recorded run be replayed
 * (or a webview re-render) and produce byte-identical state.
 */
export function buildView(events: Iterable<PipelineEvent>): ViewState {
  const state = emptyState();
  for (const e of events) reduce(state, e);
  return state;
}

/** Attach the live view. Returns a detach function. */
export function attachTerminalRenderer(
  on: (l: (e: PipelineEvent) => void) => () => void,
): () => void {
  const state = emptyState();
  let dirty = true;
  const timer = setInterval(() => {
    if (dirty) {
      logUpdate(render(state));
      dirty = false;
    }
  }, 80);

  const off = on((e) => {
    reduce(state, e);
    dirty = true;
    if (e.type === "pipeline.done") {
      logUpdate(render(state));
      logUpdate.done();
      clearInterval(timer);
    }
  });

  return () => {
    clearInterval(timer);
    off();
  };
}
