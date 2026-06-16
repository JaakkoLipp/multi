/**
 * Proves the renderer seam: a run recorded to NDJSON and replayed with NO engine
 * reproduces the exact same view. If `buildView(live) === buildView(replayed)`,
 * the live view is a pure function of the (serializable) stream — which is the
 * whole premise of the phase-2 webview.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { EventListener, PipelineEvent } from "../src/events.js";
import { attachRecorder, readEventLog, replay } from "../src/renderers/recorder.js";
import { buildView } from "../src/renderers/terminal.js";
import { tmpWorkspace } from "./helpers.js";

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("record + replay", () => {
  it("replays a recorded run, engine-free, to an identical view", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "4" });
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });

      const live: PipelineEvent[] = [];
      pipeline.on((e) => live.push(e));
      const logPath = path.join(dir, "events.ndjson");
      const detachRecorder = attachRecorder(pipeline.on, logPath);

      await pipeline.run("string utils");
      detachRecorder();

      // Wait for the NDJSON file to be fully flushed (ends on pipeline.done).
      await poll(
        () => readFile(logPath, "utf8").catch(() => ""),
        (txt) => txt.includes('"pipeline.done"'),
      );

      const recorded = await readEventLog(logPath);

      // The recording is the live stream, byte-for-byte after JSON round-trip.
      expect(recorded).toEqual(live);

      // Replay into a renderer with no engine present and capture the events it sees.
      const replayed: PipelineEvent[] = [];
      const captureAttach = (on: (l: EventListener) => () => void) =>
        on((e) => replayed.push(e));
      await replay(logPath, captureAttach, { delayMs: 0 });
      expect(replayed).toEqual(live);

      // The decisive check: the view is a pure function of the stream.
      expect(buildView(replayed)).toEqual(buildView(live));
    } finally {
      await cleanup();
    }
  }, 120_000);
});
