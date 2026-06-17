/**
 * Recorder + replay — the cheapest proof that "a renderer is a pure function of
 * the event stream".
 *
 * `attachRecorder` is an ordinary subscriber that appends each event to an
 * NDJSON file (one serialized PipelineEvent per line). `replay` reads such a
 * file and re-emits the events to any renderer's `attach(on)` — with NO engine
 * present. If the terminal view re-drawn from a recording matches the live run,
 * the engine/renderer seam is real, which is exactly the property phase 2 needs.
 *
 * Lives under renderers/: it is a consumer of the stream, never imported by the
 * engine.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EventListener, PipelineEvent } from "../events.js";

type Attach = (on: (l: EventListener) => () => void) => () => void;

/** Append every event to `filePath` as NDJSON. Returns a detach function. */
export function attachRecorder(on: (l: EventListener) => () => void, filePath: string): () => void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "w" });
  const off = on((e) => {
    stream.write(JSON.stringify(e) + "\n");
    if (e.type === "pipeline.done") stream.end();
  });
  return () => {
    off();
    stream.end();
  };
}

/** Parse an NDJSON event log back into an array of PipelineEvents. */
export async function readEventLog(filePath: string): Promise<PipelineEvent[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PipelineEvent);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Replay a recorded run into a renderer with no engine. `attach` is any
 * renderer's attach function (it receives a synthetic `on`). `delayMs` paces the
 * replay so the live view is watchable.
 */
export async function replay(
  filePath: string,
  attach: Attach,
  opts: { delayMs?: number } = {},
): Promise<PipelineEvent[]> {
  const events = await readEventLog(filePath);
  const listeners = new Set<EventListener>();
  const on = (l: EventListener) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const detach = attach(on);
  try {
    for (const e of events) {
      for (const l of listeners) l(e);
      if (opts.delayMs && e.type !== "pipeline.done") await sleep(opts.delayMs);
    }
  } finally {
    detach();
  }
  return events;
}
