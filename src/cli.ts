/**
 * CLI entrypoint — a subscriber to the engine, never the engine's only output.
 *
 * Responsibilities (all the things the engine is forbidden to do): read argv and
 * env, choose a renderer, and print the final summary. The engine itself stays
 * headless; this file is the CLI half of what the webview will do in phase 2.
 */
import path from "node:path";
import pc from "picocolors";
import { createStubAgents } from "./agents/stub.js";
import type { Agents } from "./agents/types.js";
import { loadConfig } from "./config.js";
import type { FinalRecord } from "./contracts.js";
import { createPipeline } from "./engine.js";
import { attachLogRenderer } from "./renderers/log.js";
import { attachTerminalRenderer } from "./renderers/terminal.js";

interface Cli {
  prompt: string;
  noUi: boolean;
  stub: boolean;
}

function parseArgs(argv: string[]): Cli {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positionals = argv.filter((a) => !a.startsWith("--"));
  return {
    prompt: positionals.join(" ").trim(),
    noUi: flags.has("--no-ui"),
    stub: flags.has("--stub"),
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

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.prompt) {
    console.error(
      `Usage: tsx src/cli.ts "<prompt>" [--no-ui] [--stub]\n` +
        `  --no-ui   plain event log instead of the live view (proves headlessness)\n` +
        `  --stub    deterministic LLM-free agents (no gateway needed)`,
    );
    process.exit(2);
  }

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
  const detach = cli.noUi
    ? attachLogRenderer(pipeline.on)
    : attachTerminalRenderer(pipeline.on);

  let records: FinalRecord[];
  try {
    records = await pipeline.run(cli.prompt);
  } finally {
    detach();
  }

  printSummary(records);
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
