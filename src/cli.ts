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
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { createStubAgents } from "./agents/stub.js";
import type { Agents } from "./agents/types.js";
import { loadConfig } from "./config.js";
import type { FinalRecord } from "./contracts.js";
import { CommandBus } from "./commands.js";
import { createPipeline } from "./engine.js";
import type { PipelineEvent } from "./events.js";
import { attachInkRenderer } from "./renderers/ink/index.js";
import { formatSummary, summarize } from "./metrics.js";
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
  json: boolean;
  tui: boolean;
  gates: string | null;
  review: boolean;
  pkg: boolean;
  repoSource: string | null;
  repoTestCmd: string | null;
  issue: string | null;
  track: boolean;
  pr: boolean;
}

function parseArgs(argv: string[]): Cli {
  const positionals: string[] = [];
  let noUi = false;
  let stub = false;
  let serve = false;
  let json = false;
  let tui = false;
  let record: string | null = null;
  let replayFile: string | null = null;
  let port = 7717;
  let speed = 120;
  let gates: string | null = null;
  let review = false;
  let pkg = false;
  let repoSource: string | null = null;
  let repoTestCmd: string | null = null;
  let issue: string | null = null;
  let track = false;
  let pr = false;

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
      case "--tui": tui = true; break;
      case "--review": review = true; break;
      case "--package": pkg = true; break;
      case "--json": json = true; noUi = true; break;
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
      case "--gates": {
        const { value, next } = valueOf(arg, i);
        gates = value ?? "typecheck,lint,coverage";
        i = next;
        break;
      }
      case "--repo": {
        const { value, next } = valueOf(arg, i);
        repoSource = value;
        i = next;
        break;
      }
      case "--test-cmd": {
        const { value, next } = valueOf(arg, i);
        repoTestCmd = value;
        i = next;
        break;
      }
      case "--issue": {
        const { value, next } = valueOf(arg, i);
        issue = value;
        i = next;
        break;
      }
      case "--track": track = true; break;
      case "--pr": pr = true; break;
      default: break;
    }
  }

  return {
    prompt: positionals.join(" ").trim(),
    noUi, stub, serve, record, replayFile, port, speed, json, tui, gates, review, pkg,
    repoSource, repoTestCmd, issue, track, pr,
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
      `  --tui           interactive Ink terminal UI (pause/skip/cancel via keys; needs a TTY)\n` +
      `  --json          machine-readable {summary, records} to stdout (implies --no-ui)\n` +
      `  --gates [list]  quality gates after tests (default typecheck,lint,coverage)\n` +
      `  --review        critic reviews code before testing (rejections rework)\n` +
      `  --package       assemble passing modules into a library + integration test\n` +
      `  --repo <src>    repo mode: edit an existing repo (git URL or local path)\n` +
      `  --test-cmd <c>  the repo's own test command (repo mode; default npm test)\n` +
      `  --issue o/r#n   load a GitHub issue as the task (repo mode; needs a GitHub App)\n` +
      `  --track         post + live-update progress on the issue (a dev-team bot)\n` +
      `  --pr            open a pull request from the run (links the issue)\n` +
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
  if (!cli.prompt && !cli.issue) usage();

  loadDotEnv();
  const config = loadConfig(process.env);
  if (cli.gates !== null) {
    const set = new Set(cli.gates.split(",").map((s) => s.trim()).filter(Boolean));
    config.gates.typecheck = set.has("typecheck");
    config.gates.lint = set.has("lint");
    config.gates.coverage = set.has("coverage");
  }
  if (cli.review) config.review.enabled = true;
  if (cli.pkg) config.packaging.enabled = true;
  if (cli.repoSource) {
    config.mode = "repo";
    config.repo.source = cli.repoSource;
  }
  if (cli.repoTestCmd) config.repo.testCommand = cli.repoTestCmd;
  const workspaceDir = path.resolve("workspace");

  // --- GitHub (dev-team ownership): issue -> task, live tracking, PR -----------
  // Lazily imported so `octokit` only loads when a GitHub feature is requested.
  let prompt = cli.prompt;
  let gh: import("./github/client.js").GitHubClient | null = null;
  let issueRef: import("./github/client.js").IssueRef | null = null;
  if (cli.issue || cli.track || cli.pr) {
    const { createGitHubAppClient } = await import("./github/auth.js");
    gh = await createGitHubAppClient(config.github); // throws with guidance if unconfigured
  }
  if (cli.issue) {
    const { parseIssueRef, issueToPrompt } = await import("./github/source.js");
    issueRef = parseIssueRef(cli.issue);
    const issueData = await gh!.getIssue(issueRef);
    prompt = issueToPrompt(issueData);
    config.mode = "repo";
    config.github.owner = issueRef.owner;
    config.github.repo = issueRef.repo;
    // Clone the issue's repo with a short-lived installation token.
    const token = await gh!.installationToken();
    config.repo.source = `https://x-access-token:${token}@github.com/${issueRef.owner}/${issueRef.repo}.git`;
    console.log(pc.cyan(`Loaded ${cli.issue}: ${issueData.title}`));
  }
  if (cli.track && !issueRef) {
    console.error(pc.red("--track requires --issue (the issue to post progress on)."));
    process.exit(2);
  }

  let agents: Agents;
  if (cli.stub) {
    agents = createStubAgents();
  } else {
    // Loaded lazily so the engine/stub path never pulls in Mastra or the LLM.
    const { createRealAgents } = await import("./agents/real.js");
    agents = createRealAgents(config);
  }

  // The interactive TUI needs an inbound command channel wired BEFORE run()
  // starts so its keystrokes can pause/skip/cancel. Other modes let the engine
  // own its command bus.
  const commandBus = cli.tui && !cli.json ? new CommandBus() : null;
  const pipeline = createPipeline(
    commandBus ? { config, agents, workspaceDir, commands: commandBus } : { config, agents, workspaceDir },
  );

  // Every renderer is a plain subscriber. Attach as many as requested; the
  // engine has no idea any of them exist.
  const detachers: Array<() => void> = [];
  if (!cli.json) {
    // --json keeps stdout clean for the machine-readable payload, so no
    // human-facing renderer is attached in that mode. --tui replaces the
    // read-only terminal/log renderers with the interactive Ink view.
    if (commandBus) {
      detachers.push(attachInkRenderer(pipeline.on, (c) => commandBus.send(c)));
    } else {
      detachers.push(
        cli.noUi ? attachLogRenderer(pipeline.on) : attachTerminalRenderer(pipeline.on),
      );
    }
  }
  if (cli.record) detachers.push(attachRecorder(pipeline.on, cli.record));

  // Live progress tracking on the issue — a pure subscriber, like any renderer.
  let tracker: import("./github/tracker.js").TrackerHandle | null = null;
  if (cli.track && gh && issueRef) {
    const { attachTracker } = await import("./github/tracker.js");
    tracker = attachTracker(pipeline.on, gh, issueRef);
    detachers.push(() => tracker!.detach());
    console.log(pc.cyan(`Tracking progress on ${issueRef.owner}/${issueRef.repo}#${issueRef.number}`));
  }

  // A collector so we can compute the run summary purely from the stream.
  const events: PipelineEvent[] = [];
  detachers.push(pipeline.on((e) => events.push(e)));

  const sse = cli.serve ? await startSseServer(pipeline.on, { port: cli.port }) : null;
  if (sse) console.log(pc.cyan(`\nLive view (SSE): ${sse.url}\n`));

  // Ctrl-C during a run aborts cooperatively: in-flight tests are killed and the
  // pipeline finalizes the rest as cancelled, so we still get a summary.
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("interrupted by user (SIGINT)"));
  process.once("SIGINT", onSigint);

  let records: FinalRecord[];
  try {
    records = await pipeline.run(prompt, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (tracker) await tracker.idle(); // flush the final tracking comment
    for (const d of detachers) d();
  }

  const summary = summarize(events);
  const summaryPath = path.join(workspaceDir, "output", "summary.json");
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, JSON.stringify({ summary, records }, null, 2), "utf8");

  if (cli.json) {
    process.stdout.write(JSON.stringify({ summary, records }, null, 2) + "\n");
  } else {
    printSummary(records);
    console.log("\n" + pc.bold("Metrics"));
    console.log(formatSummary(summary));
    console.log(pc.dim(`\nRun summary: ${summaryPath}`));
    if (cli.record) console.log(pc.dim(`Recorded event log: ${cli.record}`));
  }

  // Open a pull request from the run (repo mode + GitHub configured).
  if (cli.pr && gh && config.github.owner && config.github.repo && records.some((r) => r.passed)) {
    try {
      const { preparePrBranch } = await import("./github/git.js");
      const { openPullRequest } = await import("./github/pr.js");
      const token = await gh.installationToken();
      const branch = `agent/${issueRef ? `issue-${issueRef.number}` : "run"}-${Date.now()}`;
      const prep = await preparePrBranch({
        owner: config.github.owner,
        repo: config.github.repo,
        token,
        baseRef: config.repo.ref,
        branch,
        workdir: path.join(workspaceDir, "pr"),
        records,
        commitMessage: `Agent pipeline: ${(issueRef ? `#${issueRef.number} ` : "") + prompt}`.slice(0, 72),
        timeoutMs: Math.max(config.testTimeoutMs, 120_000),
      });
      if (prep.pushed) {
        const pull = await openPullRequest(gh, {
          owner: config.github.owner,
          repo: config.github.repo,
          title: issueRef ? `Resolve #${issueRef.number}` : "Agent pipeline changes",
          head: branch,
          base: config.repo.ref,
          summary,
          records,
          issueNumber: issueRef?.number ?? null,
        });
        console.log(pc.green(`\nOpened pull request: ${pull.htmlUrl}`));
      } else {
        console.error(pc.red("\nBranch push failed; PR not opened."));
      }
    } catch (err) {
      console.error(pc.red(`\nPR step failed: ${(err as Error).message}`));
    }
  }

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
