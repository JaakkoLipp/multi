/**
 * Plain event-log renderer for `--no-ui`.
 *
 * Proves the engine is fully headless: it runs the exact same engine and simply
 * prints each event as a line. Same input (the event stream), different output
 * surface — exactly like the live view and the future webview.
 */
import type { PipelineEvent } from "../events.js";

export function attachLogRenderer(
  on: (l: (e: PipelineEvent) => void) => () => void,
): () => void {
  return on((e) => {
    // eslint-disable-next-line no-console
    console.log(format(e));
  });
}

function format(e: PipelineEvent): string {
  switch (e.type) {
    case "pipeline.started":
      return `[pipeline] started ${e.runId} — "${e.prompt}"`;
    case "wbs.created":
      return `[wbs] created ${e.items.length} items: ${e.items.map((i) => i.id).join(", ")}`;
    case "item.blocked":
      return `[block] ${e.itemId} waiting on ${e.dependsOn.join(", ")}`;
    case "item.unblocked":
      return `[ready] ${e.itemId} dependencies satisfied`;
    case "item.enqueued":
      return `[enqueue] ${e.itemId} -> ${e.stage} (depth ${e.queueDepth})`;
    case "item.started":
      return `[start] ${e.stage} w${e.worker} ${e.itemId}`;
    case "item.completed":
      return `[done]  ${e.stage} w${e.worker} ${e.itemId}`;
    case "item.reworked":
      return `[rework] ${e.itemId} attempt ${e.attempt}`;
    case "item.reviewed":
      return `[review] ${e.itemId} a${e.attempt} ${e.approved ? "approved" : "changes requested"}${e.approved ? "" : ` — ${firstLine(e.notes)}`}`;
    case "item.gate":
      return `[gate]  ${e.itemId} ${e.gate} ${e.passed ? "ok" : "FAIL"}${e.detail ? ` — ${firstLine(e.detail)}` : ""}`;
    case "item.failed":
      return `[fail]  ${e.stage} ${e.itemId}: ${firstLine(e.error)}`;
    case "item.metrics":
      return `[time]  ${e.stage} ${e.itemId} a${e.attempt} ${e.durationMs}ms`;
    case "item.finalized":
      return `[final] ${e.record.workItem.id} ${e.record.passed ? "PASS" : "FAIL"} attempts=${e.record.attempts}`;
    case "pipeline.paused":
      return `[pause]  pipeline paused`;
    case "pipeline.resumed":
      return `[resume] pipeline resumed`;
    case "item.skipped":
      return `[skip]  ${e.itemId}: ${e.reason}`;
    case "item.retry.accepted":
      return `[retry] ${e.itemId} attempt ${e.attempt}`;
    case "command.rejected":
      return `[reject] ${e.command}${e.itemId ? ` ${e.itemId}` : ""}: ${e.reason}`;
    case "pipeline.cancelled":
      return `[cancel] ${e.reason}`;
    case "pipeline.packaged":
      return `[package] ${e.modules.length} modules -> ${e.dir} (integration ${e.integrationPassed ? "PASS" : "FAIL"})`;
    case "repo.acquired":
      return `[repo]   acquired ${e.ref} -> ${e.root}`;
    case "item.patch.proposed":
      return `[patch]  ${e.itemId} a${e.attempt} proposes ${e.files.length} file(s): ${e.summary}`;
    case "item.patch.applied":
      return `[patch]  ${e.itemId} a${e.attempt} applied ${e.files.join(", ")}`;
    case "item.command":
      return `[cmd]   ${e.itemId} \`${e.command}\` ${e.passed ? "PASS" : "FAIL"}`;
    case "pipeline.done":
      return `[pipeline] done: ${e.records.filter((r) => r.passed).length}/${e.records.length} passed`;
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0) ?? s;
}
