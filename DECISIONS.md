# Decisions

Decisions taken for the MVP. Each decision point (D1–D4) records the options
considered and why the chosen one wins. Investigation of the current Mastra / AI
SDK surface (per §8) is summarised first, since it drives D1.

## Investigation: current Mastra / Vercel AI SDK surface (June 2026)

Verified against installed packages (`@mastra/core@1.42`, `ai@6`,
`@ai-sdk/openai@3`) and current docs:

- **Mastra workflows** support sequential, parallel (`.parallel`), branching
  (`.branch`), and loops (`.dountil` / `.while`). Parallelism is *within a single
  workflow run* — fan-out/fan-in over steps — and loops are bounded retries of a
  step graph. There is no first-class notion of N independent per-stage queues
  with long-lived workers each draining its own queue, nor of an item hopping
  back to an *earlier stage's* queue while other items keep flowing.
- **Mastra agents** expose `agent.generate(prompt, { structuredOutput: { schema } })`
  returning a result whose `.object` is the Zod-validated value. `structuredOutput`
  accepts `jsonPromptInjection: true`, which coerces JSON via system-prompt
  injection for models that lack native `response_format` — important for local
  coder models behind LiteLLM. Agent `model` accepts an AI-SDK `LanguageModelV3`
  instance (`MastraModelConfig`), so a `createOpenAI({ baseURL })` model drops in.
- **Vercel AI SDK** `generateObject({ model, schema, prompt })` → `{ object }` is
  the verified structured-output path; `createOpenAI({ baseURL, apiKey })` +
  `provider.chat(id)` targets the OpenAI-compatible LiteLLM gateway. Note: the
  separate `@ai-sdk/openai-compatible` provider historically lacked
  `generateObject` support, so we use `@ai-sdk/openai`'s `createOpenAI` instead.

## D1 — Orchestration mechanism: **hand-rolled async orchestrator + Mastra agents for the stages**

Options: (a) model the whole pipeline as a Mastra `workflow`; (b) use Mastra
`agent`s only for the three model-driven stages and hand-roll the
queue/concurrency/cycle in plain TypeScript.

Chosen: **(b)**. The pipeline is an assembly line — three stages running
concurrently on *different* items — with independent per-stage queues and a
conditional back-edge (tester → developer) bounded by a retry cap. Mastra
workflows parallelize steps inside one run and express loops as bounded step
retries; they do not natively model independent long-lived per-stage queues or
re-enqueueing an item into an earlier stage while the line keeps moving.
Forcing that shape into a workflow would fight the primitive and muddy the event
stream. A ~120-line hand-rolled orchestrator (`engine.ts` + `queue.ts`) gives
genuine pipeline parallelism, a clean typed event stream, and trivial completion
detection. Mastra still earns its place as the agent framework for the four
model-driven stages (`agents/*.ts`), each a stateless `Agent` (instructions +
LiteLLM-bound model) used via `generate({ structuredOutput })`.

## D2 — Queue + concurrency primitive: **hand-rolled `AsyncQueue` + `WorkerPool` + `CompletionLatch`**

Options: (a) `p-queue`; (b) hand-rolled async queue over Promises.

Chosen: **(b)**. `p-queue` models fire-and-forget *tasks* with a concurrency cap;
our stages are *long-lived workers* that block-wait on a pull, and the
tester→developer re-enqueue must succeed even after a queue has momentarily
drained without losing the item or deadlocking. The hand-rolled `AsyncQueue`
(unbounded MPMC, `pull()` resolves on push or on close) plus a fixed `WorkerPool`
per stage expresses exactly that. Clean shutdown needs a global "all items
terminal" signal: `CompletionLatch` starts at `len(WBS)` and settles once per
finalized item; when it resolves the engine closes the queues, which wakes idle
pulls with `CLOSED` so every worker exits. No third stage can be mid-flight at
that point, so closing is race-free. ~90 lines, fully unit-tested.

## D3 — Test-execution sandbox: **fresh dir per attempt + child-process `vitest run` + hard timeout**

Options for the runner: `vitest`, `node --test`, bare `tsx`/`node` eval.

Chosen: **`vitest`**, with a fresh directory per item per attempt under
`workspace/runs/<runId>/`, executed in a child process (`execFile`) with a
wall-clock timeout (`TEST_TIMEOUT_MS`, `SIGKILL` on expiry) and a self-contained
`vitest.config.ts` so the child never collects the project's own suite. Vitest
transforms TypeScript on the fly via esbuild, so generated `.ts` source + spec
run with **no separate `tsc` step** — the single biggest simplification, and the
reason D4 stays TypeScript-only. `node --test` would need a TS loader and its own
assertion style; a bare eval gives no test framework. Isolation is per-attempt
directories + subprocess + timeout; there is **no kernel sandbox** (see the
README security note) — network is not firewalled, so this is for trusted local
use. (One constraint this imposes: the run workspace must live inside the project
tree so the generated spec's `import "vitest"` resolves against project
`node_modules`; the default `./workspace` satisfies this.)

## D4 — Demo target language: **TypeScript module + Vitest**

Chosen: **confirmed**. A single toolchain (TS + Vitest) means no second-language
runtime, and Vitest's on-the-fly TS transform (D3) removes any compile step from
the hot loop. The demo prompt yields one independent work item per exported
function (`slugify`, `truncateWords`, `countVowels`, `isPalindrome`,
`titleCase`) — genuinely parallelisable, and small enough that a wrong first
attempt round-trips dev↔tester quickly.

## D-EXT — Extension-readiness (locked, not a decision point)

Recorded here for traceability since it shaped the module boundaries:

- **Serializable events.** Every `PipelineEvent` is plain JSON; errors cross as
  strings; `null` (never `undefined`) marks absent fields. Enforced by
  `test/serialization.test.ts`, which round-trips every variant *and* every event
  from a real run through `JSON.parse(JSON.stringify(...))`.
- **Headless engine.** The engine modules import no `vscode`, no renderer, and no
  CLI-only API, and never print. Enforced by `test/headless.test.ts`.
- **Renderer as subscriber.** `renderers/terminal.ts` and `renderers/log.ts`
  attach via `pipeline.on`; the engine has no reference to them. `--no-ui` runs
  the identical engine with the plain-log renderer.
- **Seam proven by two extra transports.** `renderers/recorder.ts` records the
  stream to NDJSON and replays it into any renderer *with no engine*, and
  `renderers/sse.ts` broadcasts it over a socket to a browser. Tests assert the
  replayed view equals the live view and that a network client receives the
  byte-identical stream — so the phase-2 webview is demonstrably a fourth
  same-shaped renderer, not a refactor. `buildView()` is exported as the pure
  fold that makes "the view is a function of the stream" a checkable property.

## UI library: **`log-update` (+ `picocolors`)**

Chosen over `ink`. `ink` brings React + a reconciler for what is a small
in-place redraw of three stage rows; `log-update` redraws a frame string on a
timer with no framework. Lighter, and it keeps the renderer a trivial
event→string reducer — which is exactly the shape the phase-2 webview will reuse.

## Post-MVP hardening (in-scope extensions)

Added after the MVP met all acceptance criteria, staying within §11's guardrails
(no extension/persistence-DB/distributed-queue/auth/HITL/extra-roles):

- **Cooperative cancellation.** `run(prompt, { signal })` threads an `AbortSignal`
  into the sandbox (killing the vitest child) and finalizes pending items as
  cancelled, so the run resolves rather than hangs. New `pipeline.cancelled`
  event; CLI binds `Ctrl-C`. Chosen over hard `process.exit` so a renderer/webview
  still receives a clean terminal state.
- **Observability.** `item.metrics` (per-stage `durationMs`) and `pipeline.started`
  (runId/prompt/timestamp) events feed `metrics.ts::summarize()`, a pure fold to a
  `RunSummary` used by the terminal block, `--json`, and `workspace/output/summary.json`.
  Kept in the event stream (not side-channel logging) so every transport — replay,
  SSE, future webview — gets it for free.
- **Sandbox import allowlist.** `findDisallowedImports()` rejects non-self-contained
  generated source before execution (defense-in-depth for the "executes model code"
  risk), surfaced to the developer as ordinary test feedback.
- **One structured-output repair.** `generateStructured` re-asks once with the Zod
  errors appended on a parse failure — exactly the single repair §11 leaves in scope.

## SDLC capability extensions (lead-directed)

Built after the hardening sweep, on explicit direction to deepen the pipeline's
software-development capability. Each kept the headless-engine/serializable-event
design and is fully tested against deterministic stubs.

- **Dependency-aware WBS (DAG).** Items carry `dependsOn`; the orchestrator
  expresses edges by `key` and the engine resolves them to ids, rejects cycles
  (Kahn) up front, and schedules topologically via the existing finalize()/latch
  machinery — no second scheduler. Real cross-module *imports* stay out (they'd
  break the per-item sandbox + import allowlist); dependencies operate at the
  scheduling + design-context level, with the integration stage assembling
  modules for real later.
- **Quality gates (typecheck + lint + coverage).** Run after unit tests pass and
  reuse the rework edge for failures. Typecheck = standalone strict `tsc` on the
  module; lint = a parser-only ESLint flat config (fast, no type-aware project);
  coverage = vitest v8 `json-summary` parsed for line %. Gated behind config so
  the default fast path and the test suite stay quick; `--gates` enables them.

- **Review loop.** A critic agent (a fifth model role, but NOT a fourth queue/
  stage — the brief caps *roles*/stages at three pipeline stages; the reviewer is
  an in-developer-stage sub-step) reviews code before testing. Rejections reuse
  the rework edge so concurrency/back-pressure semantics are unchanged. To avoid
  failing on subjective critique alone, an exhausted review budget falls through
  to the tester, which stays the ground-truth arbiter.

- **Integration & packaging.** After the sink, passing modules are assembled into
  a single library (barrel + package.json + README) and a generated integration
  test imports the barrel and runs — the cross-module check (no name collisions,
  all importable together) that per-item unit tests structurally cannot make.
  This is where modules are wired together for real, complementing the DAG's
  scheduling-level dependencies. Emitted as pipeline.packaged before
  pipeline.done; off by default (`--package`).

## GitHub dev-team ownership (Phase 5)

- **Auth = GitHub App installation (bot identity).** Chosen over a PAT so the app
  acts as a scoped bot that "owns" the repo, posting as the App with only the
  installation's permissions, using short-lived installation tokens (appId +
  private key). Verified up front: no token exists in the sandbox; `api.github.com`
  is reachable but unauthenticated requests are rate-limited (60/hr, exhausted) so
  auth is mandatory; git is brokered through a local proxy, so live push/PR is
  real-environment only. The app uses its OWN Octokit client — never the Claude
  Code harness MCP tools.
- **Narrow `GitHubClient` interface.** Everything in `src/github/*` depends on a
  small interface, not Octokit, so the integration is unit-tested with a fake
  client and no network (`getIssue`/`createComment`/`updateComment`/`createPull`/
  `getPullFeedback`/`installationToken`). `auth.ts` is the only file that touches
  the real Octokit.
- **Tracker is a pure subscriber.** Live progress posts one issue comment on
  `wbs.created` and live-edits it from the event stream — exactly the renderer
  contract, so the engine is untouched. Writes are coalesced (≤1 trailing update).
- **Seams left clean.** `--issue` (issue→prompt→repo mode), `--track`, `--pr`
  (branch via the App token + `pulls.create`). `getPullFeedback` aggregates review
  comments + failing checks as the CI/review→rework seam; the poll/webhook loop is
  a documented follow-up.

## Out of scope (per §11)

No VS Code extension/webview, persistence, distributed queues, auth, HITL, or
extra roles. Langfuse is left as a clean hook (env vars in `.env.example`) and
not wired, since the event stream already provides the trace seam.
