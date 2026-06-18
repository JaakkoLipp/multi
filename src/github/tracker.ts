/**
 * Live progress tracker — makes the bot read like a dev team working the issue.
 *
 * A pure event subscriber (exactly like a renderer): on `wbs.created` it posts a
 * single tracking comment, then live-edits that comment as items move through
 * designer -> developer -> tester and pass/fail/rework. It never drives the
 * engine. Writes are coalesced so a burst of events produces at most one trailing
 * API update, and the final state is always flushed on `pipeline.done`.
 */
import type { EventListener, PipelineEvent } from "../events.js";
import type { GitHubClient, IssueRef } from "./client.js";

type ItemStage = "queued" | "blocked" | "design" | "develop" | "test" | "done";

interface TrackItem {
  id: string;
  title: string;
  stage: ItemStage;
  passed: boolean | null;
  attempts: number;
  reworks: number;
}

interface TrackState {
  items: Map<string, TrackItem>;
  done: boolean;
  cancelled: boolean;
  paused: boolean;
}

function emptyState(): TrackState {
  return { items: new Map(), done: false, cancelled: false, paused: false };
}

const STAGE_OF: Record<string, ItemStage> = { designer: "design", developer: "develop", tester: "test" };

export function reduce(state: TrackState, e: PipelineEvent): void {
  switch (e.type) {
    case "wbs.created":
      for (const it of e.items) {
        state.items.set(it.id, {
          id: it.id,
          title: it.title,
          stage: it.dependsOn.length > 0 ? "blocked" : "queued",
          passed: null,
          attempts: 0,
          reworks: 0,
        });
      }
      break;
    case "item.unblocked": {
      const it = state.items.get(e.itemId);
      if (it && it.stage === "blocked") it.stage = "queued";
      break;
    }
    case "item.started": {
      const it = state.items.get(e.itemId);
      if (it) it.stage = STAGE_OF[e.stage] ?? it.stage;
      break;
    }
    case "item.reworked": {
      const it = state.items.get(e.itemId);
      if (it) it.reworks += 1;
      break;
    }
    case "item.finalized": {
      const it = state.items.get(e.record.workItem.id);
      if (it) {
        it.stage = "done";
        it.passed = e.record.passed;
        it.attempts = e.record.attempts;
      }
      break;
    }
    case "pipeline.paused":
      state.paused = true;
      break;
    case "pipeline.resumed":
      state.paused = false;
      break;
    case "pipeline.cancelled":
      state.cancelled = true;
      break;
    case "pipeline.done":
      state.done = true;
      break;
    default:
      break;
  }
}

const STAGE_LABEL: Record<ItemStage, string> = {
  queued: "queued",
  blocked: "blocked",
  design: "designing",
  develop: "developing",
  test: "testing",
  done: "done",
};

export function renderTrackingComment(state: TrackState): string {
  const items = [...state.items.values()].sort((a, b) => a.id.localeCompare(b.id));
  const total = items.length;
  const done = items.filter((i) => i.stage === "done").length;
  const passed = items.filter((i) => i.passed === true).length;

  const header = state.done
    ? state.cancelled
      ? "### 🤖 Agent pipeline — cancelled"
      : "### 🤖 Agent pipeline — finished"
    : `### 🤖 Agent pipeline — working${state.paused ? " (paused)" : "…"}`;

  const rows = items.map((it) => {
    const box = it.stage === "done" ? (it.passed ? "x" : "x") : " ";
    const status =
      it.stage === "done"
        ? it.passed
          ? "✅ passed"
          : "❌ failed"
        : `⏳ ${STAGE_LABEL[it.stage]}`;
    const attempts = it.attempts > 0 ? ` · ${it.attempts} attempt${it.attempts === 1 ? "" : "s"}` : "";
    const reworks = it.reworks > 0 ? ` · ${it.reworks} rework${it.reworks === 1 ? "" : "s"}` : "";
    return `- [${box}] **${it.id}** ${it.title} — ${status}${attempts}${reworks}`;
  });

  return [
    header,
    "",
    `Progress: **${done}/${total}** done · ${passed} passed`,
    "",
    ...rows,
    "",
    "<sub>Posted and updated automatically by the agent pipeline.</sub>",
  ].join("\n");
}

export interface TrackerHandle {
  detach(): void;
  /** Resolves once all pending comment writes have flushed (for tests/shutdown). */
  idle(): Promise<void>;
}

export function attachTracker(
  on: (l: EventListener) => () => void,
  client: GitHubClient,
  ref: IssueRef,
): TrackerHandle {
  const state = emptyState();
  let commentId: number | null = null;
  let scheduled = false;
  let chain: Promise<void> = Promise.resolve();

  const flush = () => {
    if (scheduled) return;
    scheduled = true;
    chain = chain
      .then(async () => {
        scheduled = false;
        const body = renderTrackingComment(state);
        if (commentId === null) commentId = await client.createComment(ref, body);
        else await client.updateComment(ref, commentId, body);
      })
      .catch(() => {
        // A tracking-comment write must never crash the run; swallow and continue.
        scheduled = false;
      });
  };

  const off = on((e) => {
    reduce(state, e);
    // Post the comment as soon as we know the WBS; coalesce the rest.
    flush();
  });

  return {
    detach() {
      off();
    },
    idle() {
      return chain;
    },
  };
}
