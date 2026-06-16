/**
 * CLI entrypoint — a subscriber to the engine, never the engine's only output.
 *
 * Responsibilities (all the things the engine is forbidden to do): read argv and
 * env, choose renderers, and print the final summary. The engine itself stays
 * headless; this file is the CLI half of what the webview will do in phase 2.
 *
 * Modes:
 *   <prompt> [--stub] [--no-ui] [--record [file]] [--serve] [--port N]
 *   --replay <file> [--no-ui] [--speed ms]   (re-draws a recorded run, no engine)
 */
import path from "node:path";
import pc from "picocolors";
import { createStubAgents } from "./agents/stub.js";
import type { Agents } from "./agents/types.js";
import { loadConfig } from "./config.js";
import type { FinalRecord } from "./contracts.js";
import { createPipeline } from "./engine.js";
import { attachLogRenderer } from "./renderers/log.js";
import { attachRecorder, replay } from "./renderers/recorder.js";
import { startSseServer } from "./renderers/sse.js";
import { attachTerminalRenderer } from "./renderers/terminal.js";

interface Cli {
  prompt: string;
  noUi: boolean;
  stub: boolean;
  record: string | null;
  replayFile: string | null;
  serve: boolean;
  port: number;
  speed: number;
}

function parseArgs(argv: string[]): Cli {
  const positionals: string[] = [];
  let noUi = false;
  let stub = false;
  let serve = false;
  let record: string | null = null;
  let replayFile: string | null = null;
  let port = 7717;
  let speed = 120;

  const valueOf = (arg: string, i: number): { value: string | null; next: number } => {
    const eq = arg.indexOf("=");
    if (eq !== -1) return { value: arg.slice(eq + 1), next: i };
    const peek = argv[i + 1];
    if (peek && !peek.startsWith("--")) return { value: peek, next: i + 1 };
    return { value: null, next: i };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.split("=")[0];
    switch (name) {
      case "--no-ui": noUi = true; break;
      case "--stub": stub = true; break;
      case "--serve": serve = true; break;
      case "--record": {
        const { value, next } = valueOf(arg, i);
        record = value ?? path.resolve("workspace", "events.ndjson");
        i = next;
        break;
      }
      case "--replay": {
        const { value, next } = valueOf(arg, i);
        replayFile = value;
        i = next;
        break;
      }
      case "--port": {
        const { value, next } = valueOf(arg, i);
        if (value) port = Number(value);
        i = next;
        break;
      }
      case "--speed": {
        const { value, next } = valueOf(arg, i);
        if (value) speed = Number(value);
        i = next;
        break;
      }
      default: break;
    }
  }

  return {
    prompt: positionals.join(" ").trim(),
    noUi, stub, serve, record, replayFile, port, speed,
  };
}

function loadDotEnv(): void {
  try {
    // Node 20.12+/22 native .env loader; ignored if the file is absent.
    process.loadEnvFile?.(path.resolve(".env"));
  } catch {
    /* no .env file — rely on the ambient environment */
  }
}

function usage(): never {
  console.error(
    `Usage:\n` +
      `  tsx src/cli.ts "<prompt>" [--stub] [--no-ui] [--record [file]] [--serve] [--port N]\n` +
      `  tsx src/cli.ts --replay <file> [--no-ui] [--speed ms]\n\n` +
      `  --stub          deterministic LLM-free agents (no gateway needed)\n` +
      `  --no-ui         plain event log instead of the live view (proves headlessness)\n` +
      `  --record [file] persist the event stream as NDJSON (default workspace/events.ndjson)\n` +
      `  --serve         broadcast the stream over SSE; open the printed URL to watch in a browser\n` +
      `  --replay <file> re-draw a recorded run with NO engine (proves the renderer seam)`,
  );
  process.exit(2);
}

/** Replay mode: drive a renderer from a recorded NDJSON file, no engine at all. */
async function runReplay(cli: Cli): Promise<void> {
  const attach = cli.noUi ? attachLogRenderer : (on: Parameters<typeof attachTerminalRenderer>[0]) => attachTerminalRenderer(on);
  const events = await replay(cli.replayFile!, attach, { delayMs: cli.speed });
  const done = events.find((e) => e.type === "pipeline.done");
  if (done?.type === "pipeline.done") printSummary(done.records);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.replayFile) {
    await runReplay(cli);
    return;
  }
  if (!cli.prompt) usage();

  loadDotEnv();
  const config = loadConfig(process.env);
  const workspaceDir = path.resolve("workspace");

  let agents: Agents;
  if (cli.stub) {
    agents = createStubAgents();
  } else {
    // Loaded lazily so the engine/stub path never pulls in Mastra or the LLM.
    const { createRealAgents } = await import("./agents/real.js");
    agents = createRealAgents(config);
  }

  const pipeline = createPipeline({ config, agents, workspaceDir });

  // Every renderer is a plain subscriber. Attach as many as requested; the
  // engine has no idea any of them exist.
  const detachers: Array<() => void> = [];
  detachers.push(
    cli.noUi ? attachLogRenderer(pipeline.on) : attachTerminalRenderer(pipeline.on),
  );
  if (cli.record) detachers.push(attachRecorder(pipeline.on, cli.record));

  const sse = cli.serve ? await startSseServer(pipeline.on, { port: cli.port }) : null;
  if (sse) console.log(pc.cyan(`\nLive view (SSE): ${sse.url}\n`));

  let records: FinalRecord[];
  try {
    records = await pipeline.run(cli.prompt);
  } finally {
    for (const d of detachers) d();
  }

  printSummary(records);
  if (cli.record) console.log(pc.dim(`\nRecorded event log: ${cli.record}`));

  if (sse) {
    console.log(pc.cyan(`\nServing the recorded run at ${sse.url} — press Ctrl-C to stop.`));
    await new Promise<void>((resolve) => process.on("SIGINT", resolve));
    await sse.close();
  }
  process.exit(records.every((r) => r.passed) ? 0 : 1);
}

function printSummary(records: FinalRecord[]): void {
  console.log("\n" + pc.bold("Summary"));
  for (const r of records) {
    const status = r.passed ? pc.green("PASS") : pc.red("FAIL");
    console.log(
      `  ${r.workItem.id}  ${status}  attempts=${r.attempts}  ${pc.dim(r.workItem.title)}`,
    );
  }
  const passed = records.filter((r) => r.passed).length;
  console.log(pc.bold(`\n${passed}/${records.length} passed`));
}

main().catch((err) => {
  console.error(pc.red("Pipeline crashed:"), err);
  process.exit(1);
});
