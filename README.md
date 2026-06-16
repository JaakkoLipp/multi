# agent-pipeline

A concurrent, multi-agent code-generation pipeline. One natural-language prompt
goes in; an **orchestrator** decomposes it into a Work Breakdown Structure, and
the items flow through a three-stage assembly line — **designer → developer →
tester** — where each stage is a separate agent draining its own queue and all
three run **concurrently on different items**. The tester actually executes the
generated code; on failure it routes the item back to the developer's queue with
the failing-test feedback, bounded by a retry cap.

This is phase 1 (a CLI) of a two-phase plan. Phase 2 is a Cline-style VS Code
extension that reuses this exact engine behind a webview. The single
architectural rule that makes that cheap: **the engine is headless and emits a
typed event stream; every renderer is just a consumer of that stream.**

```
prompt
  → Orchestrator (1 LLM call) → WBS: WorkItem[]
      → designerQueue  → [Designer workers]  → DesignSpec    → developerQueue
      → developerQueue → [Developer workers] → CodeArtifact  → testerQueue
      → testerQueue    → [Tester workers]    → run tests:
                                                pass → sink (FinalRecord)
                                                fail & attempts left → developerQueue (feedback)
                                                fail & exhausted      → sink (failed)
  → engine awaits len(WBS) terminal records, then stops workers
```

## Quick start

```bash
npm install
cp .env.example .env      # point LITELLM_BASE_URL / *_MODEL at your gateway

# Real run (needs a LiteLLM gateway):
npm run demo
# i.e. npx tsx src/cli.ts "Build a TypeScript module string_utils exporting: \
#   slugify(text), truncateWords(text, n), countVowels(text), isPalindrome(text), titleCase(text)"

# No gateway? Deterministic stub agents exercise the whole engine for real
# (real Vitest execution, real rework loop):
npx tsx src/cli.ts "string utils" --stub

# Prove the engine is headless — same engine, plain event log instead of the live view:
npx tsx src/cli.ts "string utils" --stub --no-ui

# Record the event stream, then re-draw the run with NO engine (proves the seam):
npx tsx src/cli.ts "string utils" --stub --record workspace/run.ndjson
npx tsx src/cli.ts --replay workspace/run.ndjson

# Watch a run in a browser — the engine broadcasts its stream over SSE:
npx tsx src/cli.ts "string utils" --stub --serve   # open the printed URL

# Machine-readable output for scripts/CI:
npx tsx src/cli.ts "string utils" --stub --json | jq .summary
```

Flags: `--stub` (LLM-free deterministic agents), `--no-ui` (plain event log),
`--record [file]` (persist the stream as NDJSON), `--replay <file>` (re-draw a
recording with no engine), `--serve`/`--port N` (broadcast over SSE), `--json`
(machine-readable `{summary, records}`).

Every run also writes `workspace/output/summary.json` (the aggregate metrics +
final records) and the terminal prints a per-stage metrics block (run counts,
total/avg/max time, rework count, pass rate). `Ctrl-C` cancels cooperatively:
in-flight tests are killed and the run still resolves with a summary.

Passing modules are written to `workspace/output/<id>-<fn>/` as `module.ts` +
`module.test.ts`; each spec passes when run independently
(`npx vitest run --root workspace/output/<id>-<fn>`).

## Live view

Without `--no-ui` you get an in-place terminal view derived entirely from the
event stream: per-stage worker activity, queue depths, rework count, and
done/total — so you can watch designer, developer, and tester all working
different items at once, and items bouncing back for rework.

## Phase-2 seam, proven not just claimed

Phase 2 (a Cline-style VS Code extension) runs the engine in the extension host
and renders in a webview — a separate process fed only serializable messages.
Three renderers already exercise that exact seam, all as pure `pipeline.on`
subscribers the engine knows nothing about:

- **`renderers/terminal.ts`** — the live in-place view (the webview's understudy).
- **`renderers/recorder.ts`** — records the stream to NDJSON and `replay`s it into
  any renderer with **no engine present**. `test/replay.test.ts` asserts the view
  rebuilt from a recording is identical to the live one — i.e. the view is a pure
  function of the (serializable) stream.
- **`renderers/sse.ts`** — broadcasts the stream over SSE; a browser at `/` renders
  the run with zero engine knowledge. This is `engine.on(e => transport.send(...))`
  across a socket — the hardest version of the postMessage boundary. `test/sse.test.ts`
  asserts a network client receives the byte-identical stream.

Swapping in the webview is then a fourth renderer of the same shape.

## Configuration

All config is env (validated by `src/config.ts`); see `.env.example`. Models are
configured per stage and accessed via a **LiteLLM gateway** (OpenAI-compatible
HTTP) — bring your own; nothing is hard-wired to a hosted/editor model, so a
fully local / EU-sovereign setup works.

## Architecture / where things live

| File | Role |
| --- | --- |
| `src/contracts.ts` | Zod schemas + inferred types (the data contracts) |
| `src/events.ts` | `PipelineEvent` union + typed `EventBus` (the seam) |
| `src/queue.ts` | `AsyncQueue` / `WorkerPool` / `CompletionLatch` (D2) |
| `src/sandbox.ts` | write + run generated specs in isolation + import allowlist (D3) |
| `src/llm.ts` | AI-SDK provider bound to LiteLLM + `generateObject` helper |
| `src/metrics.ts` | pure `summarize(events)` fold → run summary / aggregate metrics |
| `src/agents/*` | orchestrator / designer / developer / tester (Mastra) + stubs; one structured-output repair retry |
| `src/engine.ts` | headless: wires queues + workers, emits events, cancellation, awaits completion |
| `src/renderers/*` | `terminal.ts`, `log.ts`, `recorder.ts` (NDJSON record/replay), `sse.ts` — subscribers only |
| `src/cli.ts` | entrypoint: argv + env + renderers + summary |

The engine modules import nothing from `vscode` and nothing CLI-only; the CLI
imports the engine, and the future extension will import the same engine. See
[`DECISIONS.md`](./DECISIONS.md) for D1–D4 and the rationale.

## Tests

```bash
npm test         # vitest: engine behaviour, queue, serialization, headlessness
npm run typecheck
```

The suite enforces the two extension-readiness invariants directly: every event
survives a `JSON.parse(JSON.stringify(...))` round-trip
(`test/serialization.test.ts`), and no engine module imports `vscode` or a
CLI-only API (`test/headless.test.ts`). The engine tests run the full pipeline on
stub agents with **real** Vitest execution, including the dev↔tester rework loop.

## Robustness

- **Cooperative cancellation.** `run(prompt, { signal })` (and `Ctrl-C` from the
  CLI) aborts cleanly: in-flight test runs are killed via the signal threaded
  into the sandbox, pending items are finalized as cancelled, and `run()` still
  resolves with a record per item. Surfaced as a `pipeline.cancelled` event.
- **Sandbox import allowlist.** The generated module must be self-contained;
  `sandbox.ts` rejects any source that imports an external/`node:` module
  *before* executing it, and routes that back to the developer as feedback.
- **One structured-output repair.** If an LLM stage returns a value that fails
  its Zod schema, the agent is re-asked exactly once with the validation errors
  appended before the item is failed (`agents/mastra.ts`).
- **Quality gates.** After unit tests pass, optional gates run on the generated
  module: strict `tsc --noEmit` (typecheck), ESLint (lint), and a Vitest line-
  coverage threshold. A failing gate routes the item back to the developer with
  the gate output as feedback. Enable with `--gates` or `GATE_*` env vars; each
  is surfaced as an `item.gate` event. Off by default.
- **Dependency-aware scheduling (DAG).** The orchestrator can express
  dependencies between work items; the engine validates acyclicity and schedules
  topologically — dependents wait (`item.blocked`) until their dependencies pass
  (`item.unblocked`), and are cascade-failed if a dependency cannot pass.
- **Per-stage metrics.** Each stage emits an `item.metrics` event; `summarize()`
  folds the stream into pass rate, rework count, and per-stage timing.

## ⚠️ Security

**This engine executes model-generated code on your machine.** The tester writes
and runs generated tests against generated source. Isolation here is a fresh
directory per attempt, a child process, and a hard timeout — there is **no
container or VM sandbox, and the network is not firewalled**. Run it only on a
trusted local machine, against a gateway you control. Do not point it at
untrusted prompts on a shared or production host.

> Note: the run workspace must live inside the project tree (the default
> `./workspace` does) so generated specs resolve `vitest` from the project's
> `node_modules`.
