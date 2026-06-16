/**
 * Proves the phase-2 bridge across a real socket boundary: the engine emits, the
 * SSE renderer serializes with JSON.stringify, and a separate client deserializes
 * the identical stream. This is `engine.on(e => postMessage(e))` with a network
 * in the middle — the hardest version of the webview boundary.
 */
import http from "node:http";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { startSseServer } from "../src/renderers/sse.js";
import { tmpWorkspace } from "./helpers.js";

/** Minimal SSE client: collects parsed `data:` payloads until pipeline.done. */
function collectSse(url: string): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  return new Promise<PipelineEvent[]>((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const evt = JSON.parse(dataLine.slice(5).trim()) as PipelineEvent;
          events.push(evt);
          if (evt.type === "pipeline.done") resolve(events);
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

describe("SSE broadcaster", () => {
  it("delivers the exact serialized event stream to a connected client", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    const config = loadConfig({ MAX_WBS_ITEMS: "3" });
    const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });

    const emitted: PipelineEvent[] = [];
    pipeline.on((e) => emitted.push(e));

    const sse = await startSseServer(pipeline.on, { port: 0 });
    try {
      const received$ = collectSse(`http://localhost:${sse.port}/events`);
      await pipeline.run("string utils");
      const received = await received$;

      // The client sees the same events, post JSON.stringify -> JSON.parse.
      expect(received).toEqual(emitted);
      expect(received.at(-1)?.type).toBe("pipeline.done");
    } finally {
      await sse.close();
      await cleanup();
    }
  }, 120_000);

  it("serves an HTML page for the browser understudy", async () => {
    const pipeline = createPipeline({
      config: loadConfig({}),
      agents: createStubAgents(),
    });
    const sse = await startSseServer(pipeline.on, { port: 0 });
    try {
      const html = await new Promise<string>((resolve, reject) => {
        http.get(sse.url, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
          res.on("error", reject);
        });
      });
      expect(html).toContain("EventSource");
    } finally {
      await sse.close();
    }
  }, 30_000);
});
