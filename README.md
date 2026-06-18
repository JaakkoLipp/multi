# agent-pipeline

A concurrent, multi-agent software-development pipeline. One natural-language
prompt goes in; an **orchestrator** decomposes it into a Work Breakdown Structure
(a DAG of work items), and the items flow through a three-stage assembly line —
**designer → developer → tester** — where each stage is a separate agent draining
its own queue and all three run **concurrently on different items**. The tester
actually executes the code; on failure it routes the item back to the developer's
queue with the failing feedback, bounded by a retry cap.

The single architectural rule that everything else hangs off:

> **The engine is headless and emits a typed, JSON-serializable event stream;
> every renderer is just a subscriber. The mirror of that — an inbound,
> equally-serializable command channel — lets a consumer steer a running pipeline.**

That out-stream + in-channel pair is a symmetric bridge: it is exactly what a
phase-2 Cline-style VS Code webview needs (`postMessage` out, `onDidReceiveMessage`
in), proven today by terminal, NDJSON-replay, SSE-over-socket, and an interactive
Ink TUI — four renderers the engine knows nothing about.

The pipeline runs in **two modes** and can be **owned by a GitHub dev-team bot**:

- **Module mode** — generates standalone TypeScript modules + Vitest specs.
- **Repo mode** — clones/copies an existing repo, proposes multi-file patches, and
  runs the repository's **own** test/lint/build commands in a per-item working copy.
- **GitHub ownership** — a GitHub **App** (bot identity) turns an issue into a task,
  live-tracks progress on the issue, opens a PR, and feeds CI/review back as rework.

```
prompt
  → Orchestrator (1 LLM call) → WBS: WorkItem[] (+ dependsOn DAG)
      → designerQueue  → [Designer workers]  → spec   → developerQueue
      → developerQueue → [Developer workers] → code/patch → testerQueue
      → testerQueue    → [Tester workers]    → run tests / repo checks:
                                                pass → sink (FinalRecord)
                                                fail & attempts left → developerQueue (feedback)
                                                fail & exhausted      → sink (failed)
  → engine awaits len(WBS) terminal records, then stops workers
```

## Quick start

```bash
npm install
npm run setup             # interactive: configure the LLM + GitHub App, test both, write .env
#   or: cp .env.example .env  and edit by hand
npm run check             # re-test the current .env's LLM + GitHub connections
```

`npm run setup` walks you through the LLM gateway (base URL, key, model ids) and,
optionally, a GitHub App (App ID, private-key `.pem`, installation ID, owner/repo)
and repo-mode commands (`REPO_SETUP_CMD` like `npm ci`, `REPO_TEST_CMD`). It can
run a live **structured-output round-trip** against your model and **mint a GitHub
installation token** to confirm both work before a real run, then merges the
values into `.env` (existing keys + comments preserved).

No gateway needed to explore — `--stub` runs deterministic, LLM-free agents
through the **real** engine (real Vitest execution, real rework loop, real repo
checks):

```bash
# Module run, deterministic stub agents (no gateway):
npx tsx src/cli.ts "string utils" --stub

# Prove the engine is headless — same engine, plain event log instead of the view:
npx tsx src/cli.ts "string utils" --stub --no-ui

# Interactive TUI: pause/resume, select + skip an item, cancel — all via keys:
npx tsx src/cli.ts "string utils" --stub --tui

# Watch a run in a browser — the engine broadcasts its stream over SSE:
npx tsx src/cli.ts "string utils" --stub --serve     # open the printed URL

# Record the stream, then re-draw the run with NO engine (proves the seam):
npx tsx src/cli.ts "string utils" --stub --record workspace/run.ndjson
npx tsx src/cli.ts --replay workspace/run.ndjson

# Machine-readable output for scripts/CI:
npx tsx src/cli.ts "string utils" --stub --json | jq .summary

# Quality gates + review loop + packaging together:
npx tsx src/cli.ts "string utils" --stub --gates --review --package

# Repo mode: edit an existing repo and run ITS own test command:
npx tsx src/cli.ts "fix the add bug" --stub --repo test/fixtures/repo --test-cmd "node test.mjs"

# Real LLM run (needs a LiteLLM gateway):
npm run demo
# i.e. npx tsx src/cli.ts "Build a TypeScript module string_utils exporting: \
#   slugify(text), truncateWords(text, n), countVowels(text), isPalindrome(text), titleCase(text)"
```

Every run writes `workspace/output/summary.json` (aggregate metrics + final
records) and prints a per-stage metrics block (run counts, total/avg/max time,
rework count, pass rate). In module mode, passing modules are written to
`workspace/output/<id>-<fn>/` as `module.ts` + `module.test.ts`; each spec passes
when run independently (`npx vitest run --root workspace/output/<id>-<fn>`).
`Ctrl-C` cancels cooperatively: in-flight tests are killed and the run still
resolves with a summary.

### CLI flags

| Flag | Effect |
| --- | --- |
| `--stub` | Deterministic LLM-free agents (no gateway needed). |
| `--no-ui` | Plain event log instead of the live view (proves headlessness). |
| `--tui` | Interactive Ink terminal UI; pause/skip/cancel via keys (needs a TTY). |
| `--serve` / `--port N` | Broadcast the stream over SSE; open the printed URL (default port 7717). |
| `--record [file]` | Persist the event stream as NDJSON (default `workspace/events.ndjson`). |
| `--replay <file>` | Re-draw a recorded run with **no engine** (`--speed ms` sets the frame delay). |
| `--json` | Machine-readable `{summary, records}` to stdout (implies `--no-ui`). |
| `--gates [list]` | Quality gates after tests pass (default `typecheck,lint,coverage`). |
| `--review` | A critic reviews code before testing; rejections rework. |
| `--package` | Assemble passing modules into a library + run an integration test. |
| `--repo <src>` | Repo mode: edit an existing repo (git URL or local path). |
| `--test-cmd <c>` | The repo's own test command in repo mode (default `npm test`). |
| `--issue o/r#n` | Load a GitHub issue as the task (repo mode; needs a GitHub App). |
| `--track` | Post + live-update a progress comment on the issue (the dev-team bot). |
| `--pr` | Open a pull request from the run (links the issue). |

## Two modes

Both modes share every primitive — queues, worker pools, the completion latch,
the DAG finalize/cascade, the pause gate, the command channel — and differ only in
the three stage handlers. The mode is selected by `MODE` / `--repo` / `--issue`
and dispatched by `engine.ts` (`runPipeline` vs `runRepoPipeline`).

| | Module mode | Repo mode |
| --- | --- | --- |
| Target | Standalone TS modules | An existing repository |
| Designer output | `DesignSpec` | `RepoDesignSpec` (against real code) |
| Developer output | A self-contained module | A multi-file `Patch` (edits) |
| Tester runs | Generated Vitest spec (sandbox) | The repo's **own** test/lint/build commands |
| Isolation | Fresh dir per attempt | A per-item working copy (concurrent, conflict-free) |
| Output | `workspace/output/<id>-<fn>/` | Applied patch per passing item (basis for a PR) |

Module mode is the demo target (D4); repo mode is the path to GitHub dev-team
ownership — its patches become the commits a PR is built from.

## Live control

The pipeline exposes an inbound **command channel** — the serializable mirror of
the outbound event stream. Commands are plain JSON (`PipelineCommand` in
`src/commands.ts`) so a webview can send them over the same bridge it receives
events on. Wire one in by passing a `CommandBus` to `createPipeline`, or call
`pipeline.send(cmd)` directly. Supported today: `run.cancel`, `pipeline.pause`,
`pipeline.resume`, and `item.cancel` (skip a single item — it cascades to DAG
dependents like any non-pass). `item.retry` / `item.reprioritize` are accepted but
acknowledged as `command.rejected` (documented follow-ups).

The `--tui` Ink renderer is the interactive consumer of that channel:

| Key | Action |
| --- | --- |
| `space` / `p` | Pause / resume the run |
| `↑` / `↓` | Select an item |
| `x` | Skip the selected item |
| `c` / `q` | Cancel the run |

## GitHub dev-team ownership

The app can act as a **bot that owns a repo**: take an issue as its task, post
live progress, and open a PR — all under a **GitHub App installation** identity.

- **Auth (`GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID`).** The
  app authenticates as a GitHub App *installation* and mints short-lived,
  installation-scoped tokens — never a static PAT, never the harness's credentials.
  It posts as the App with only the permissions the installation granted, using its
  **own** Octokit client (never the Claude Code harness MCP tools). `src/github/auth.ts`
  is the only file that touches the real Octokit; everything else depends on the
  narrow `GitHubClient` interface so the integration is unit-tested with a fake.
- **`--issue owner/repo#n`** — the issue's title + body become the run prompt, and
  its repo becomes the repo-mode target (cloned with an installation token).
- **`--track`** — a pure event subscriber posts one tracking comment on
  `wbs.created` and live-edits it as items move through the stages (coalesced
  writes, flushed on `pipeline.done`). Requires `--issue`.
- **`--pr`** — builds a branch from the passing items' patches via the App token and
  opens a pull request that links the issue (`Closes #N`).
- **CI/review → rework loop** — `getPullFeedback` aggregates a PR's review comments
  and failing checks into a fresh rework prompt (`src/github/watch.ts`), closing the
  ownership loop. The poll/webhook trigger for the re-run is a documented follow-up.

> **Requires a GitHub App.** `api.github.com` allows only 60 unauthenticated
> req/hr, so auth is mandatory. **Live push/PR is real-environment only:** the
> development sandbox has no token and brokers git through a local proxy, so the
> GitHub write paths (like the live LLM path) are API-correct but unexercised here.

## Robustness

- **Cooperative cancellation.** `run(prompt, { signal })` (and `Ctrl-C`, and the
  `run.cancel` command) aborts cleanly: in-flight test runs are killed via the
  signal threaded into the sandbox, pending items are finalized as cancelled, and
  `run()` still resolves with a record per item. Surfaced as `pipeline.cancelled`.
- **Pause / resume / skip.** The command channel parks workers at a pause gate
  (no queue is closed, so the run stays resumable, not hung) and can skip a single
  item mid-run.
- **Sandbox import allowlist.** Generated modules must be self-contained;
  `sandbox.ts` rejects any source importing an external/`node:` module *before*
  executing it, routed back to the developer as feedback.
- **One structured-output repair.** If an LLM stage returns a value that fails its
  Zod schema, the agent is re-asked exactly once with the validation errors appended
  before the item is failed.
- **Quality gates.** After unit tests pass, optional gates run: strict `tsc --noEmit`,
  ESLint (parser-only flat config), and a Vitest line-coverage threshold. A failing
  gate reworks via the developer edge; each is an `item.gate` event. `--gates` / `GATE_*`.
- **Review loop.** `--review` / `REVIEW_ENABLED` adds a critic that reviews code
  against the spec *before* testing; a rejection reuses the rework edge (no extra
  queue, `item.reviewed`). An exhausted budget falls through to the tester, the
  final arbiter.
- **Dependency-aware scheduling (DAG).** Items carry `dependsOn`; the engine maps
  keys to ids, validates acyclicity (Kahn) up front, and schedules topologically —
  dependents wait (`item.blocked`) until their dependencies pass (`item.unblocked`),
  and cascade-fail if a dependency cannot pass.
- **Integration & packaging.** `--package` / `PACKAGE_ENABLED` assembles passing
  modules into one library (barrel `index.ts` + `package.json` + `README`) under
  `workspace/output/package/` and runs a generated cross-module integration test
  (`pipeline.packaged`).
- **Repo mode checks.** Patches are applied into a per-item working copy and the
  repo's own test → lint → build commands run in order; a failure reworks
  (`item.command`, `item.patch.applied`).
- **Metrics & summary.** Each stage emits `item.metrics`; `summarize()` folds the
  stream into pass rate, rework count, and per-stage timing — used by the terminal
  block, `--json`, and `summary.json`.

## Architecture / where things live

The engine modules import nothing from `vscode` and nothing CLI-only; the CLI
imports the engine, and the future extension will import the same engine. See
[`DECISIONS.md`](./DECISIONS.md) for D1–D4, the post-MVP hardening, the SDLC
capability extensions, and the GitHub dev-team phase.

| File | Role |
| --- | --- |
| `src/contracts.ts` | Zod schemas + inferred types (the data contracts) |
| `src/events.ts` | `PipelineEvent` union + typed `EventBus` (the outbound seam) |
| `src/commands.ts` | `PipelineCommand` union + `CommandBus` (the inbound control seam) |
| `src/queue.ts` | `AsyncQueue` / `WorkerPool` / `CompletionLatch` (D2) |
| `src/sandbox.ts` | write + run generated specs / repo commands in isolation + import allowlist (D3) |
| `src/repo.ts` | repo-mode working copy, read-only `RepoContext`, multi-file patch apply |
| `src/llm.ts` | AI-SDK provider bound to LiteLLM + `generateObject` helper |
| `src/metrics.ts` | pure `summarize(events)` fold → `RunSummary` / aggregate metrics |
| `src/packager.ts` | integration & packaging stage: assemble passing modules into a library |
| `src/agents/*` | orchestrator / designer / developer / tester / reviewer + repo agents (Mastra) + stubs; one structured-output repair |
| `src/engine.ts` | headless: `createPipeline`, `runPipeline` (module) / `runRepoPipeline` (repo), cancellation, DAG, completion |
| `src/github/auth.ts` | GitHub **App** installation auth → short-lived tokens (the only Octokit caller) |
| `src/github/client.ts` | the narrow `GitHubClient` interface everything else depends on (mockable) |
| `src/github/source.ts` | input seam: parse `owner/repo#n`, turn an issue into the run prompt |
| `src/github/tracker.ts` | live progress comment — a pure event subscriber (renderer contract) |
| `src/github/pr.ts` | output seam: build the PR body + open the pull request |
| `src/github/git.ts` | clone/branch/commit/push the passing patches (real-environment only) |
| `src/github/watch.ts` | CI/review feedback → rework prompt (closes the ownership loop) |
| `src/renderers/terminal.ts` | live in-place terminal view (subscriber) |
| `src/renderers/log.ts` | plain event-log renderer (`--no-ui`, subscriber) |
| `src/renderers/recorder.ts` | NDJSON record + `replay` into any renderer with no engine |
| `src/renderers/sse.ts` | broadcast the stream over SSE to a browser |
| `src/renderers/ink/*` | interactive TUI: `model.ts` (pure reducer), `App.tsx` (view), `index.ts` (attach + `send`) |
| `src/cli.ts` | entrypoint: argv + env + renderers + GitHub wiring + summary |

### The headless-engine invariant, enforced by tests

Two properties make the phase-2 webview a fourth same-shaped renderer rather than
a refactor, and both are asserted directly by the suite:

- **Serializable both ways.** Every `PipelineEvent` *and* every `PipelineCommand`
  survives `JSON.parse(JSON.stringify(...))` (`null` never `undefined`, errors as
  strings) — `test/serialization.test.ts`, `test/commands.test.ts`.
- **Headless engine.** No engine module imports `vscode` or a CLI-only API and the
  engine never prints — `test/headless.test.ts`. Renderers attach only via
  `pipeline.on`; the engine holds no reference to them. `--no-ui` runs the identical
  engine with the plain-log renderer; `--replay` rebuilds the view from a recording
  with no engine present (`test/replay.test.ts`), and `test/sse.test.ts` asserts a
  network client receives the byte-identical stream.

The outbound event stream and the inbound command channel are the symmetric
bridge a Cline-style VS Code webview reuses: `engine.on(e => panel.postMessage(e))`
out, `webview.onDidReceiveMessage(cmd => pipeline.send(cmd))` in.

## Configuration

All config is env (validated by `src/config.ts`); see `.env.example`. Models are
configured per stage (`ORCHESTRATOR_MODEL`, `DESIGNER_MODEL`, `DEVELOPER_MODEL`,
`TESTER_MODEL`, `REVIEWER_MODEL`) and accessed via a **LiteLLM gateway**
(OpenAI-compatible HTTP) — bring your own; nothing is hard-wired to a hosted/editor
model, so a fully local / EU-sovereign setup works.

| Group | Vars |
| --- | --- |
| Gateway | `LITELLM_BASE_URL`, `LITELLM_API_KEY` |
| Models | `ORCHESTRATOR_MODEL`, `DESIGNER_MODEL`, `DEVELOPER_MODEL`, `TESTER_MODEL`, `REVIEWER_MODEL` |
| Mode | `MODE` (`module` / `repo`), `REPO_SOURCE`, `REPO_REF`, `REPO_TEST_CMD`, `REPO_LINT_CMD`, `REPO_BUILD_CMD` |
| Engine knobs | `MAX_WBS_ITEMS`, `MAX_REWORK_ATTEMPTS`, `TEST_TIMEOUT_MS`, `DESIGNER_CONCURRENCY`, `DEVELOPER_CONCURRENCY`, `TESTER_CONCURRENCY` |
| Review | `REVIEW_ENABLED` |
| Packaging | `PACKAGE_ENABLED`, `PACKAGE_NAME` |
| Gates | `GATE_TYPECHECK`, `GATE_LINT`, `GATE_COVERAGE`, `COVERAGE_MIN` |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_OWNER`, `GITHUB_REPO` |
| Tracing (hook) | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (left as a clean hook, not wired) |

## Extension-readiness

Phase 2 (a Cline-style VS Code extension) runs this exact engine in the extension
host and renders in a webview. Nothing here needs to change: the four existing
renderers (terminal, recorder/replay, SSE-over-socket, Ink TUI) already exercise
the postMessage boundary — the recorder/SSE pair across a process/network gap, and
the TUI across the *inbound* command channel. The webview is a fifth subscriber of
the same shape. `buildView()` is exported as the pure stream→view fold that makes
"the view is a function of the stream" a checkable property.

## ⚠️ Security

**This engine executes model-generated code on your machine.** In module mode the
tester writes and runs generated tests against generated source. **In repo mode it
runs the target repository's own lifecycle scripts** (its `test`/`lint`/`build`
commands) over model-proposed patches. Isolation is a fresh directory / working
copy per attempt, a child process, and a hard timeout — there is **no container or
VM sandbox, and the network is not firewalled**. Run it only on a trusted local
machine, against a gateway and repositories you control. Do not point it at
untrusted prompts, issues, or repos on a shared or production host.

**GitHub tokens are GitHub App *installation* tokens**, minted at runtime from the
App id + private key supplied via env (`GITHUB_*`) — short-lived and
installation-scoped. They are never hard-coded, never sourced from the Claude Code
harness, and the app uses its own Octokit client, not harness MCP tools.

> Note: the run workspace must live inside the project tree (the default
> `./workspace` does) so generated specs resolve `vitest` from the project's
> `node_modules`.

## Tests

```bash
npm test         # vitest: engine behaviour, queue, serialization, control, modes, GitHub
npm run typecheck
```

~87 tests (22 files) run **offline against deterministic stubs and fixtures with real
execution** — the full pipeline on stub agents with real Vitest runs (including
the dev↔tester rework loop), real repo-mode checks against `test/fixtures/repo`,
the DAG/cancellation/pause/gates/review/packaging paths, the Ink model/app, and
the GitHub integration against a fake `GitHubClient`. The live LLM and live-GitHub
(push/PR) paths are unexercised here — there is no gateway or token in the
sandbox — but are API-correct.
</content>
</invoke>
