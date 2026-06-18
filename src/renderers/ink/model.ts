/**
 * Pure view-model for the Ink TUI.
 *
 * This is the interactive sibling of `renderers/terminal.ts`: the ENTIRE view is
 * derived from the event stream by a pure reducer, with one twist — updates are
 * IMMUTABLE (each `reduce` returns a new TuiModel) so React's `useState` sees a
 * fresh reference and re-renders. No React, no ink, no I/O here: fully unit
 * testable in isolation, and replayable byte-for-byte from a recorded run.
 */
import type { Stage } from "../../contracts.js";
import type { PipelineEvent } from "../../events.js";

/** The per-item lifecycle position, derived from the stage events. */
export type ItemStage = "queued" | "blocked" | "design" | "develop" | "test" | "done";

export interface TuiItem {
  id: string;
  title: string;
  stage: ItemStage;
  /** null until finalized; then true (passed) or false (failed/skipped). */
  passed: boolean | null;
  attempts: number;
  reworks: number;
  lastError: string | null;
}

export interface StageActivity {
  depth: number;
  active: string[];
}

export interface TuiModel {
  designer: StageActivity;
  developer: StageActivity;
  tester: StageActivity;
  items: TuiItem[];
  total: number;
  done: number;
  passed: number;
  failed: number;
  reworks: number;
  blocked: number;
  paused: boolean;
  cancelled: boolean;
  busyMs: number;
  selectedIndex: number;
  /** Last ~8 human-readable event lines. */
  recent: string[];
}

const RECENT_MAX = 8;

/** Map an engine Stage onto the item's lifecycle label. */
const STAGE_LABEL: Record<Stage, ItemStage> = {
  designer: "design",
  developer: "develop",
  tester: "test",
};

export function emptyModel(): TuiModel {
  return {
    designer: { depth: 0, active: [] },
    developer: { depth: 0, active: [] },
    tester: { depth: 0, active: [] },
    items: [],
    total: 0,
    done: 0,
    passed: 0,
    failed: 0,
    reworks: 0,
    blocked: 0,
    paused: false,
    cancelled: false,
    busyMs: 0,
    selectedIndex: 0,
    recent: [],
  };
}

/** Shallow-clone a model so we can mutate the copy and hand back a new ref. */
function clone(model: TuiModel): TuiModel {
  return {
    ...model,
    designer: { depth: model.designer.depth, active: [...model.designer.active] },
    developer: { depth: model.developer.depth, active: [...model.developer.active] },
    tester: { depth: model.tester.depth, active: [...model.tester.active] },
    items: model.items.map((it) => ({ ...it })),
    recent: [...model.recent],
  };
}

function stageOf(model: TuiModel, stage: Stage): StageActivity {
  return model[stage];
}

function pushRecent(model: TuiModel, line: string): void {
  model.recent.push(line);
  if (model.recent.length > RECENT_MAX) model.recent.shift();
}

function findItem(model: TuiModel, id: string): TuiItem | undefined {
  return model.items.find((it) => it.id === id);
}

function addActive(stage: StageActivity, id: string): void {
  if (!stage.active.includes(id)) stage.active.push(id);
}

function removeActive(stage: StageActivity, id: string): void {
  const i = stage.active.indexOf(id);
  if (i !== -1) stage.active.splice(i, 1);
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0) ?? s;
}

/**
 * Fold one event into the model, returning a NEW model. Unknown event types are
 * a no-op (the original reference is returned so React skips the re-render).
 */
export function reduce(model: TuiModel, e: PipelineEvent): TuiModel {
  switch (e.type) {
    case "pipeline.started": {
      const next = clone(model);
      pushRecent(next, `run ${e.runId} started`);
      return next;
    }
    case "wbs.created": {
      const next = clone(model);
      next.total = e.items.length;
      next.items = e.items.map((it) => ({
        id: it.id,
        title: it.title,
        stage: it.dependsOn.length > 0 ? "blocked" : "queued",
        passed: null,
        attempts: 0,
        reworks: 0,
        lastError: null,
      }));
      pushRecent(next, `WBS created: ${e.items.length} items`);
      return next;
    }
    case "item.blocked": {
      const next = clone(model);
      next.blocked += 1;
      const it = findItem(next, e.itemId);
      if (it) it.stage = "blocked";
      return next;
    }
    case "item.unblocked": {
      const next = clone(model);
      if (next.blocked > 0) next.blocked -= 1;
      const it = findItem(next, e.itemId);
      if (it && it.passed === null) it.stage = "queued";
      pushRecent(next, `${e.itemId} unblocked`);
      return next;
    }
    case "item.enqueued": {
      const next = clone(model);
      stageOf(next, e.stage).depth = e.queueDepth;
      const it = findItem(next, e.itemId);
      if (it && it.passed === null && it.stage !== "design" && it.stage !== "develop" && it.stage !== "test") {
        it.stage = "queued";
      }
      return next;
    }
    case "item.started": {
      const next = clone(model);
      const stage = stageOf(next, e.stage);
      addActive(stage, e.itemId);
      if (stage.depth > 0) stage.depth -= 1;
      const it = findItem(next, e.itemId);
      if (it) it.stage = STAGE_LABEL[e.stage];
      return next;
    }
    case "item.completed": {
      const next = clone(model);
      removeActive(stageOf(next, e.stage), e.itemId);
      return next;
    }
    case "item.reworked": {
      const next = clone(model);
      next.reworks += 1;
      removeActive(next.tester, e.itemId);
      const it = findItem(next, e.itemId);
      if (it) {
        it.reworks += 1;
        it.lastError = e.feedback;
      }
      pushRecent(next, `${e.itemId} reworked -> dev (attempt ${e.attempt})`);
      return next;
    }
    case "item.failed": {
      const next = clone(model);
      removeActive(stageOf(next, e.stage), e.itemId);
      const it = findItem(next, e.itemId);
      if (it) it.lastError = e.error;
      return next;
    }
    case "item.metrics": {
      const next = clone(model);
      next.busyMs += e.durationMs;
      const it = findItem(next, e.itemId);
      if (it) it.attempts = Math.max(it.attempts, e.attempt);
      return next;
    }
    case "item.gate": {
      if (e.passed) return model;
      const next = clone(model);
      pushRecent(next, `${e.itemId} gate ${e.gate} failed`);
      return next;
    }
    case "item.reviewed": {
      if (e.approved) return model;
      const next = clone(model);
      pushRecent(next, `${e.itemId} review: changes requested`);
      return next;
    }
    case "item.finalized": {
      const next = clone(model);
      next.done += 1;
      if (e.record.passed) next.passed += 1;
      else next.failed += 1;
      const it = findItem(next, e.record.workItem.id);
      if (it) {
        it.stage = "done";
        it.passed = e.record.passed;
        it.attempts = e.record.attempts;
        it.lastError = e.record.lastError;
      }
      // A finalized item is no longer active in any stage.
      removeActive(next.designer, e.record.workItem.id);
      removeActive(next.developer, e.record.workItem.id);
      removeActive(next.tester, e.record.workItem.id);
      pushRecent(
        next,
        `${e.record.workItem.id} ${e.record.passed ? "PASS" : "FAIL"} (${e.record.attempts} attempt${e.record.attempts === 1 ? "" : "s"})`,
      );
      return next;
    }
    case "pipeline.paused": {
      const next = clone(model);
      next.paused = true;
      pushRecent(next, "pipeline paused");
      return next;
    }
    case "pipeline.resumed": {
      const next = clone(model);
      next.paused = false;
      pushRecent(next, "pipeline resumed");
      return next;
    }
    case "item.skipped": {
      const next = clone(model);
      removeActive(next.designer, e.itemId);
      removeActive(next.developer, e.itemId);
      removeActive(next.tester, e.itemId);
      const it = findItem(next, e.itemId);
      if (it && it.lastError === null) it.lastError = `skipped: ${e.reason}`;
      pushRecent(next, `${e.itemId} skipped: ${e.reason}`);
      return next;
    }
    case "item.retry.accepted": {
      const next = clone(model);
      pushRecent(next, `${e.itemId} retry (attempt ${e.attempt})`);
      return next;
    }
    case "command.rejected": {
      const next = clone(model);
      pushRecent(next, `command ${e.command} rejected: ${e.reason}`);
      return next;
    }
    case "pipeline.cancelled": {
      const next = clone(model);
      next.cancelled = true;
      pushRecent(next, `cancelled: ${e.reason}`);
      return next;
    }
    case "pipeline.packaged": {
      const next = clone(model);
      pushRecent(
        next,
        `packaged ${e.modules.length} modules — integration ${e.integrationPassed ? "PASS" : "FAIL"}`,
      );
      return next;
    }
    case "repo.acquired": {
      const next = clone(model);
      pushRecent(next, `repo acquired (${e.ref})`);
      return next;
    }
    case "item.patch.proposed": {
      const next = clone(model);
      pushRecent(next, `${e.itemId} proposes ${e.files.length} file(s): ${firstLine(e.summary)}`);
      return next;
    }
    case "item.patch.applied": {
      const next = clone(model);
      pushRecent(next, `${e.itemId} patched ${e.files.length} file(s)`);
      return next;
    }
    case "item.command": {
      const next = clone(model);
      const it = findItem(next, e.itemId);
      if (it && !e.passed && e.detail) it.lastError = e.detail;
      pushRecent(next, `${e.itemId} ${e.command} ${e.passed ? "PASS" : "FAIL"}`);
      return next;
    }
    case "pipeline.done":
      return model;
    default:
      return model;
  }
}

/** Clamp `selectedIndex` into [0, items.length-1] and return a new model. */
export function moveSelection(model: TuiModel, delta: number): TuiModel {
  if (model.items.length === 0) {
    if (model.selectedIndex === 0) return model;
    return { ...model, selectedIndex: 0 };
  }
  const max = model.items.length - 1;
  let next = model.selectedIndex + delta;
  if (next < 0) next = 0;
  if (next > max) next = max;
  if (next === model.selectedIndex) return model;
  return { ...model, selectedIndex: next };
}

/** The currently selected item, or null when the list is empty. */
export function selectedItem(model: TuiModel): TuiItem | null {
  if (model.items.length === 0) return null;
  const i = Math.min(Math.max(model.selectedIndex, 0), model.items.length - 1);
  return model.items[i] ?? null;
}
