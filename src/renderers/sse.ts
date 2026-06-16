/**
 * SSE broadcaster — the phase-2 webview bridge in miniature.
 *
 * In phase 2 the bridge is literally `engine.on(e => panel.webview.postMessage(e))`:
 * the engine runs in one process and a separate process renders from the
 * serialized stream. This renderer is the same shape across an even harder
 * boundary — a network socket: `engine.on(e => res.write(JSON.stringify(e)))`.
 * A browser at `/` renders the run live with zero engine knowledge, proving the
 * stream is a sufficient and serializable interface.
 *
 * Dependency-free (node:http). Events are buffered so a client that connects
 * mid/after-run still receives the whole sequence. Lives under renderers/: it is
 * a consumer of the stream, never imported by the engine.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { EventListener, PipelineEvent } from "../events.js";

export interface SseHandle {
  port: number;
  url: string;
  /** Stop broadcasting and close the server (and any open client connections). */
  close: () => Promise<void>;
}

export async function startSseServer(
  on: (l: EventListener) => () => void,
  opts: { port?: number } = {},
): Promise<SseHandle> {
  const clients = new Set<http.ServerResponse>();
  const buffer: PipelineEvent[] = [];

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      // Replay what already happened so late joiners see the full run.
      for (const e of buffer) res.write(frame(e));
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });

  const off = on((e) => {
    buffer.push(e);
    const data = frame(e);
    for (const res of clients) res.write(data);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://localhost:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        off();
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}

function frame(e: PipelineEvent): string {
  // `event:` lets EventSource dispatch by type; `data:` is the serialized payload.
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Minimal "webview understudy": renders the run from the stream alone. */
const PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>agent-pipeline</title>
<style>
  body { font: 14px ui-monospace, monospace; background: #111; color: #ddd; padding: 1rem; }
  .stage { margin: .25rem 0; }
  .stage b { display: inline-block; width: 6rem; }
  .active { color: #4ec9b0; } .idle { color: #666; }
  #log div { color: #999; } .pass { color: #4ec9b0; } .fail { color: #f48771; }
  .rework { color: #dcdcaa; }
</style>
<h3>Multi-agent pipeline <span id="summary"></span></h3>
<div id="stages"></div>
<h4>recent</h4>
<div id="log"></div>
<script>
  const stages = { designer: new Set(), developer: new Set(), tester: new Set() };
  const depth = { designer: 0, developer: 0, tester: 0 };
  let total = 0, done = 0, pass = 0, reworks = 0;
  const es = new EventSource("/events");
  const log = (html, cls) => {
    const d = document.createElement("div"); d.innerHTML = html; if (cls) d.className = cls;
    const box = document.getElementById("log"); box.prepend(d);
    while (box.children.length > 8) box.lastChild.remove();
  };
  const draw = () => {
    document.getElementById("summary").textContent =
      \`— done \${done}/\${total} · \${pass} pass · reworks \${reworks}\`;
    document.getElementById("stages").innerHTML = Object.keys(stages).map(s => {
      const a = [...stages[s]];
      return \`<div class="stage"><b>\${s}</b> <span class="idle">q:\${depth[s]}</span> \` +
        (a.length ? \`<span class="active">\${a.join(" ")}</span>\` : \`<span class="idle">idle</span>\`) + "</div>";
    }).join("");
  };
  es.addEventListener("wbs.created", e => { total = JSON.parse(e.data).items.length; draw(); });
  es.addEventListener("item.enqueued", e => { const d = JSON.parse(e.data); depth[d.stage] = d.queueDepth; draw(); });
  es.addEventListener("item.started", e => { const d = JSON.parse(e.data); stages[d.stage].add(d.itemId); if (depth[d.stage]>0) depth[d.stage]--; draw(); });
  es.addEventListener("item.completed", e => { const d = JSON.parse(e.data); stages[d.stage].delete(d.itemId); draw(); });
  es.addEventListener("item.failed", e => { const d = JSON.parse(e.data); stages[d.stage].delete(d.itemId); draw(); });
  es.addEventListener("item.reworked", e => { const d = JSON.parse(e.data); reworks++; stages.tester.delete(d.itemId); log(\`\${d.itemId} reworked → dev (attempt \${d.attempt})\`, "rework"); draw(); });
  es.addEventListener("item.finalized", e => { const r = JSON.parse(e.data).record; done++; if (r.passed) pass++; log(\`\${r.workItem.id} \${r.passed?"PASS":"FAIL"} (\${r.attempts} attempts)\`, r.passed?"pass":"fail"); draw(); });
  es.addEventListener("pipeline.done", () => es.close());
</script>
`;
