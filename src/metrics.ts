/**
 * metrics.ts — a pure fold from the event stream to a run summary.
 *
 * Like the renderers, this is a function of the (serializable) event stream and
 * nothing else: feed it live events, a replayed NDJSON log, or the events a
 * webview received over postMessage, and it yields the same RunSummary. The CLI
 * uses it for the aggregate stats block, the `--json` output, and the persisted
 * `summary.json`; phase 2 can compute the identical summary client-side.
 */
import type { Stage } from "./contracts.js";
import type { PipelineEvent } from "./events.js";

export interface StageMetrics {
  /** Number of stage executions (includes reruns from rework). */
  runs: number;
  totalMs: number;
  maxMs: number;
}

export interface ItemSummary {
  id: string;
  title: string;
  passed: boolean;
  attempts: number;
  lastError: string | null;
}

export interface RunSummary {
  runId: string | null;
  prompt: string | null;
  total: number;
  passed: number;
  failed: number;
  reworks: number;
  cancelled: boolean;
  cancelReason: string | null;
  /** Sum of all stage execution times — the total compute the pipeline did. */
  busyMs: number;
  perStage: Record<Stage, StageMetrics>;
  items: ItemSummary[];
}

const STAGES: Stage[] = ["designer", "developer", "tester"];

function emptyStage(): StageMetrics {
  return { runs: 0, totalMs: 0, maxMs: 0 };
}

export function summarize(events: Iterable<PipelineEvent>): RunSummary {
  const summary: RunSummary = {
    runId: null,
    prompt: null,
    total: 0,
    passed: 0,
    failed: 0,
    reworks: 0,
    cancelled: false,
    cancelReason: null,
    busyMs: 0,
    perStage: {
      designer: emptyStage(),
      developer: emptyStage(),
      tester: emptyStage(),
    },
    items: [],
  };

  for (const e of events) {
    switch (e.type) {
      case "pipeline.started":
        summary.runId = e.runId;
        summary.prompt = e.prompt;
        break;
      case "wbs.created":
        summary.total = e.items.length;
        break;
      case "item.reworked":
        summary.reworks += 1;
        break;
      case "item.metrics": {
        const s = summary.perStage[e.stage];
        s.runs += 1;
        s.totalMs += e.durationMs;
        s.maxMs = Math.max(s.maxMs, e.durationMs);
        summary.busyMs += e.durationMs;
        break;
      }
      case "pipeline.cancelled":
        summary.cancelled = true;
        summary.cancelReason = e.reason;
        break;
      case "item.finalized":
        if (e.record.passed) summary.passed += 1;
        else summary.failed += 1;
        summary.items.push({
          id: e.record.workItem.id,
          title: e.record.workItem.title,
          passed: e.record.passed,
          attempts: e.record.attempts,
          lastError: e.record.lastError,
        });
        break;
      default:
        break;
    }
  }

  summary.items.sort((a, b) => a.id.localeCompare(b.id));
  return summary;
}

/** Pretty multi-line aggregate block for the terminal. */
export function formatSummary(s: RunSummary): string {
  const lines: string[] = [];
  const pct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  lines.push(`pass rate   ${s.passed}/${s.total} (${pct}%)`);
  lines.push(`reworks     ${s.reworks}`);
  lines.push(`busy time   ${(s.busyMs / 1000).toFixed(1)}s across all stages`);
  for (const stage of STAGES) {
    const m = s.perStage[stage];
    const avg = m.runs > 0 ? Math.round(m.totalMs / m.runs) : 0;
    lines.push(
      `  ${stage.padEnd(9)} ${String(m.runs).padStart(2)} runs · ${(m.totalMs / 1000).toFixed(1)}s · avg ${avg}ms · max ${m.maxMs}ms`,
    );
  }
  if (s.cancelled) lines.push(`cancelled   ${s.cancelReason ?? "yes"}`);
  return lines.join("\n");
}
