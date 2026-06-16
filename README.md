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
```

Flags: `--stub` (LLM-free deterministic agents), `--no-ui` (plain event log).

Passing modules are written to `workspace/output/<id>-<fn>/` as `module.ts` +
`module.test.ts`; each spec passes when run independently
(`npx vitest run --root workspace/output/<id>-<fn>`).

## Live view

Without `--no-ui` you get an in-place terminal view derived entirely from the
event stream: per-stage worker activity, queue depths, rework count, and
done/total — so you can watch designer, developer, and tester all working
different items at once, and items bouncing back for rework.

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
| `src/sandbox.ts` | write + run generated specs in isolation (D3) |
| `src/llm.ts` | AI-SDK provider bound to LiteLLM + `generateObject` helper |
| `src/agents/*` | orchestrator / designer / developer / tester (Mastra) + stubs |
| `src/engine.ts` | headless: wires queues + workers, emits events, awaits completion |
| `src/renderers/*` | `terminal.ts` (live view) and `log.ts` (`--no-ui`) — subscribers only |
| `src/cli.ts` | entrypoint: argv + env + renderer + summary |

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
