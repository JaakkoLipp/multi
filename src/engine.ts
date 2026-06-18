/**
 * engine.ts — the headless pipeline.
 *
 * Wires three per-stage queues and worker pools, runs all three stages
 * concurrently on different items (assembly-line parallelism), implements the
 * bounded tester -> developer rework back-edge, emits a typed event stream, and
 * resolves run() once every work item has reached a terminal state.
 *
 * Headless & extension-ready (see §1a): imports nothing from `vscode`, never
 * touches argv/stdout, never calls a renderer, produces no console output. It
 * only emits PipelineEvents. The CLI and the future webview both just subscribe.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig } from "./config.js";
import {
  CodeArtifact,
  type DesignSpec,
  type FinalRecord,
  type Patch,
  type RepoDesignSpec,
  type Stage,
  type WorkItem,
} from "./contracts.js";
import { CommandBus, type PipelineCommand } from "./commands.js";
import { EventBus, type EventListener, type PipelineEvent } from "./events.js";
import { assemblePackage } from "./packager.js";
import { AsyncQueue, CompletionLatch, WorkerPool } from "./queue.js";
import { applyEdits, createRepoContext, prepareWorkingCopy, type RepoContext } from "./repo.js";
import {
  lintModule,
  runCommand,
  runTests,
  SOURCE_FILE,
  SOURCE_IMPORT,
  TEST_FILE,
  typecheckModule,
} from "./sandbox.js";
import type { Agents } from "./agents/types.js";

export interface CreatePipelineOptions {
  config: PipelineConfig;
  agents: Agents;
  /** Where run artifacts + passing output are written. Defaults to ./workspace. */
  workspaceDir?: string;
  /** Inbound command channel. If omitted, the engine creates its own (reachable
   * via pipeline.send). Pass one to wire commands before run() starts. */
  commands?: CommandBus;
}

export interface RunOptions {
  /** Abort the run cooperatively: in-flight test execution is killed, remaining
   * items are finalized as cancelled, and run() resolves with their records. */
  signal?: AbortSignal;
}

export interface Pipeline {
  run(prompt: string, opts?: RunOptions): Promise<FinalRecord[]>;
  /** Subscribe to the event stream. Returns an unsubscribe function. */
  on(listener: EventListener): () => void;
  /** Async-iterable view of the same stream. */
  events(): AsyncGenerator<PipelineEvent>;
  /** Send a control command into a running pipeline (mirror of `on`). */
  send(command: PipelineCommand): void;
}

interface DevJob {
  item: WorkItem;
  spec: DesignSpec;
  attempt: number;
  previousCode: string | null;
  feedback: string | null;
}

interface TestJob {
  item: WorkItem;
  spec: DesignSpec;
  code: CodeArtifact;
}

interface ItemState {
  attempts: number;
  passed: boolean;
  sourceCode: string | null;
  testSource: string | null;
  lastError: string | null;
}

export function createPipeline(options: CreatePipelineOptions): Pipeline {
  const { config, agents } = options;
  const workspaceDir = options.workspaceDir ?? path.resolve("workspace");
  const bus = new EventBus();
  const commands = options.commands ?? new CommandBus();

  return {
    on: (l) => bus.on(l),
    events: () => bus.events(),
    send: (cmd) => commands.send(cmd),
    run: (prompt, opts) => {
      const ctx = { config, agents, workspaceDir, bus, commands };
      return config.mode === "repo"
        ? runRepoPipeline(ctx, prompt, opts)
        : runPipeline(ctx, prompt, opts);
    },
  };
}

async function runPipeline(
  ctx: {
    config: PipelineConfig;
    agents: Agents;
    workspaceDir: string;
    bus: EventBus;
    commands: CommandBus;
  },
  prompt: string,
  opts: RunOptions = {},
): Promise<FinalRecord[]> {
  const { config, agents, workspaceDir, bus, commands } = ctx;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workspaceDir, "runs", runId);
  const outputDir = path.join(workspaceDir, "output");

  const designerQueue = new AsyncQueue<WorkItem>();
  const developerQueue = new AsyncQueue<DevJob>();
  const testerQueue = new AsyncQueue<TestJob>();

  const states = new Map<string, ItemState>();
  const records = new Map<string, FinalRecord>();
  const emit = (e: PipelineEvent) => bus.emit(e);

  emit({ type: "pipeline.started", runId, prompt, startedAt: Date.now() });

  // --- WBS + dependency graph ----------------------------------------------
  const wbs = await agents.orchestrate(prompt, config.maxWbsItems);
  const raws = wbs.items.slice(0, config.maxWbsItems);
  const ids = raws.map((_, i) => `wi-${String(i + 1).padStart(3, "0")}`);
  // The model expresses dependencies by `key`; map those to the ids we assign.
  const keyToId = new Map<string, string>();
  raws.forEach((raw, i) => {
    if (raw.key) keyToId.set(raw.key, ids[i]!);
  });
  const items: WorkItem[] = raws.map((raw, i) => {
    const self = ids[i]!;
    const deps = Array.from(
      new Set(
        (raw.dependsOn ?? [])
          .map((k) => keyToId.get(k))
          .filter((id): id is string => id !== undefined && id !== self),
      ),
    );
    return {
      id: self,
      title: raw.title,
      description: raw.description,
      acceptanceCriteria: raw.acceptanceCriteria,
      dependsOn: deps,
    };
  });

  const itemsById = new Map(items.map((it) => [it.id, it]));
  assertAcyclic(items); // fail fast on a malformed (cyclic) graph

  const dependents = new Map<string, string[]>(); // depId -> ids that need it
  const unmet = new Map<string, number>(); // itemId -> deps not yet passed
  const designSpecs = new Map<string, DesignSpec>(); // itemId -> its design (for context)
  for (const item of items) {
    states.set(item.id, { attempts: 0, passed: false, sourceCode: null, testSource: null, lastError: null });
    unmet.set(item.id, item.dependsOn.length);
    for (const dep of item.dependsOn) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(item.id);
    }
  }
  emit({ type: "wbs.created", items });

  const latch = new CompletionLatch(items.length);

  const enqueueDesigner = (item: WorkItem) => {
    designerQueue.push(item);
    emit({ type: "item.enqueued", stage: "designer", itemId: item.id, queueDepth: designerQueue.depth });
  };

  // Building-block context for a dependent: the design specs of its passed deps.
  const dependencyContextFor = (item: WorkItem): DesignSpec[] =>
    item.dependsOn.map((d) => designSpecs.get(d)).filter((s): s is DesignSpec => s !== undefined);

  const finalize = (item: WorkItem) => {
    if (records.has(item.id)) return; // idempotent
    const s = states.get(item.id)!;
    const record: FinalRecord = {
      workItem: item,
      passed: s.passed,
      attempts: s.attempts,
      sourceCode: s.sourceCode,
      testSource: s.testSource,
      lastError: s.lastError,
      patch: null,
    };
    records.set(item.id, record);
    emit({ type: "item.finalized", record });
    latch.settleOne();

    // Propagate to dependents: admit those now unblocked, cascade-fail those
    // whose dependency did not pass (they can never run).
    for (const depId of dependents.get(item.id) ?? []) {
      if (records.has(depId)) continue;
      const dependent = itemsById.get(depId)!;
      if (s.passed) {
        const remaining = unmet.get(depId)! - 1;
        unmet.set(depId, remaining);
        if (remaining === 0 && !cancelled) {
          emit({ type: "item.unblocked", itemId: depId });
          enqueueDesigner(dependent);
        }
      } else {
        const ds = states.get(depId)!;
        ds.lastError = `blocked: dependency ${item.id} did not pass`;
        emit({ type: "item.failed", itemId: depId, stage: "designer", error: ds.lastError });
        finalize(dependent); // recurses to cascade further
      }
    }
  };

  // --- Cancellation ---------------------------------------------------------
  // On abort: stop scheduling new work, kill in-flight test runs (via the
  // signal threaded into the sandbox), and finalize everything still pending as
  // cancelled. That settles the latch, so run() resolves cleanly with records.
  const { signal } = opts;
  let cancelled = false;

  // Pause gate: checked at the top of each stage handler (NOT inside WorkerPool,
  // which stays untouched). Pausing parks workers that have already pulled an item
  // *before* they start work; it finalizes nothing and closes no queue, so the
  // CompletionLatch is simply not yet satisfied — run() stays pending (resumable),
  // it does not hang as a bug. cancelRun must drain the waiters or a cancel issued
  // while paused would deadlock parked workers.
  let paused = false;
  const resumeWaiters: Array<() => void> = [];
  const waitWhilePaused = (): Promise<void> => {
    if (!paused || cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => resumeWaiters.push(resolve));
  };
  const drainResumeWaiters = () => {
    for (const resolve of resumeWaiters.splice(0)) resolve();
  };

  const cancelRun = (reason: string) => {
    if (cancelled) return;
    cancelled = true;
    paused = false;
    drainResumeWaiters(); // wake any parked workers so they observe cancellation
    emit({ type: "pipeline.cancelled", reason });
    for (const item of items) {
      if (records.has(item.id)) continue;
      const s = states.get(item.id)!;
      if (s.lastError === null) s.lastError = "cancelled";
      finalize(item);
    }
  };
  const onAbort = () => cancelRun(abortReason(signal));
  signal?.addEventListener("abort", onAbort, { once: true });

  // Inbound command channel. Phase 0 wires run.cancel (behaviourally identical to
  // the AbortSignal path); other commands are acknowledged as rejected for now so
  // the serializable contract exists end to end.
  const dispatchCommand = (cmd: PipelineCommand) => {
    switch (cmd.type) {
      case "run.cancel":
        cancelRun(cmd.reason || "cancelled by command");
        break;
      case "pipeline.pause":
        if (!paused && !cancelled) {
          paused = true;
          emit({ type: "pipeline.paused", at: Date.now() });
        }
        break;
      case "pipeline.resume":
        if (paused) {
          paused = false;
          emit({ type: "pipeline.resumed", at: Date.now() });
          drainResumeWaiters();
        }
        break;
      case "item.cancel": {
        const item = itemsById.get(cmd.itemId);
        if (!item || records.has(cmd.itemId)) {
          emit({ type: "command.rejected", command: cmd.type, itemId: cmd.itemId, reason: "unknown or already finalized item" });
          break;
        }
        const s = states.get(cmd.itemId)!;
        if (s.lastError === null) s.lastError = `skipped: ${cmd.reason}`;
        emit({ type: "item.skipped", itemId: cmd.itemId, reason: cmd.reason });
        finalize(item); // idempotent; cascades to DAG dependents like any non-pass
        break;
      }
      default: {
        // item.retry / item.reprioritize: acknowledged but not yet supported.
        // Retry-after-finalize needs a latch +1 / record-eviction protocol, and
        // the FIFO queue has no priority. Both are documented follow-ups.
        const itemId = "itemId" in cmd ? cmd.itemId : null;
        emit({ type: "command.rejected", command: cmd.type, itemId, reason: "not supported yet" });
        break;
      }
    }
  };
  const offCommand = commands.onCommand(dispatchCommand);

  // Time one stage's processing and emit an item.metrics event.
  const timed = async <T>(
    stage: Stage,
    itemId: string,
    attempt: number,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      emit({
        type: "item.metrics",
        stage,
        itemId,
        attempt,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };

  // Quality gates run after unit tests pass. Each enabled gate is executed and
  // surfaced as an item.gate event; the aggregated feedback (null if all pass)
  // is routed back to the developer via the normal rework edge.
  const runQualityGates = async (
    itemId: string,
    attemptDir: string,
    testRun: { coveragePct: number | null },
  ): Promise<string | null> => {
    const failures: string[] = [];
    const record = (gate: "typecheck" | "lint" | "coverage", passed: boolean, detail: string) =>
      emit({ type: "item.gate", itemId, gate, passed, detail });

    if (config.gates.typecheck) {
      const g = await typecheckModule(attemptDir, config.testTimeoutMs);
      record("typecheck", g.ok, g.ok ? "" : firstLines(g.output));
      if (!g.ok) failures.push(`Type check failed:\n${g.output}`);
    }
    if (config.gates.lint) {
      const g = await lintModule(attemptDir, config.testTimeoutMs);
      record("lint", g.ok, g.ok ? "" : firstLines(g.output));
      if (!g.ok) failures.push(`Lint failed:\n${g.output}`);
    }
    if (config.gates.coverage) {
      const pct = testRun.coveragePct;
      const ok = pct !== null && pct >= config.gates.coverageMin;
      record("coverage", ok, `${pct ?? "unknown"}% (min ${config.gates.coverageMin}%)`);
      if (!ok) failures.push(`Coverage ${pct ?? "unknown"}% is below the ${config.gates.coverageMin}% threshold; add tests.`);
    }
    return failures.length > 0 ? failures.join("\n\n") : null;
  };

  // --- Designer stage -------------------------------------------------------
  const designerPool = new WorkerPool<WorkItem>(
    designerQueue,
    config.concurrency.designer,
    async (item, worker) => {
      if (cancelled) return;
      await waitWhilePaused();
      if (cancelled) return;
      emit({ type: "item.started", stage: "designer", itemId: item.id, worker });
      try {
        const out = await timed("designer", item.id, 1, () =>
          agents.design({ item, dependencies: dependencyContextFor(item) }),
        );
        if (cancelled) return;
        const spec: DesignSpec = { workItemId: item.id, ...out };
        designSpecs.set(item.id, spec);
        emit({ type: "item.completed", stage: "designer", itemId: item.id, worker });
        developerQueue.push({ item, spec, attempt: 1, previousCode: null, feedback: null });
        emit({ type: "item.enqueued", stage: "developer", itemId: item.id, queueDepth: developerQueue.depth });
      } catch (err) {
        const s = states.get(item.id)!;
        s.lastError = errorMessage(err);
        emit({ type: "item.failed", itemId: item.id, stage: "designer", error: s.lastError });
        finalize(item);
      }
    },
  );

  // --- Developer stage ------------------------------------------------------
  const developerPool = new WorkerPool<DevJob>(
    developerQueue,
    config.concurrency.developer,
    async (job, worker) => {
      const { item } = job;
      if (cancelled) return;
      await waitWhilePaused();
      if (cancelled) return;
      emit({ type: "item.started", stage: "developer", itemId: item.id, worker });
      try {
        const out = await timed("developer", item.id, job.attempt, () =>
          agents.develop({
            spec: job.spec,
            dependencies: dependencyContextFor(item),
            previousCode: job.previousCode,
            feedback: job.feedback,
            attempt: job.attempt,
          }),
        );
        if (cancelled) return;
        const code = CodeArtifact.parse({
          workItemId: item.id,
          functionName: out.functionName,
          sourceCode: out.sourceCode,
          attempt: job.attempt,
          feedback: job.feedback,
        });
        const s = states.get(item.id)!;
        s.attempts = job.attempt;
        s.sourceCode = code.sourceCode;
        emit({ type: "item.completed", stage: "developer", itemId: item.id, worker });

        // Optional critic pass before testing. A rejection reuses the rework
        // edge (re-enqueue to the developer); on an exhausted budget we let the
        // tester be the final arbiter rather than failing on the critic alone.
        if (config.review.enabled) {
          const verdict = await timed("developer", item.id, job.attempt, () =>
            agents.review({ item, spec: job.spec, sourceCode: code.sourceCode, attempt: job.attempt }),
          );
          if (cancelled) return;
          emit({ type: "item.reviewed", itemId: item.id, attempt: job.attempt, approved: verdict.approved, notes: verdict.notes });
          if (!verdict.approved && job.attempt <= config.maxReworkAttempts) {
            const nextAttempt = job.attempt + 1;
            s.lastError = verdict.notes;
            emit({ type: "item.reworked", itemId: item.id, attempt: nextAttempt, feedback: verdict.notes });
            developerQueue.push({ item, spec: job.spec, attempt: nextAttempt, previousCode: code.sourceCode, feedback: verdict.notes });
            emit({ type: "item.enqueued", stage: "developer", itemId: item.id, queueDepth: developerQueue.depth });
            return;
          }
        }

        testerQueue.push({ item, spec: job.spec, code });
        emit({ type: "item.enqueued", stage: "tester", itemId: item.id, queueDepth: testerQueue.depth });
      } catch (err) {
        const s = states.get(item.id)!;
        s.lastError = errorMessage(err);
        emit({ type: "item.failed", itemId: item.id, stage: "developer", error: s.lastError });
        finalize(item);
      }
    },
  );

  // --- Tester stage ---------------------------------------------------------
  const testerPool = new WorkerPool<TestJob>(
    testerQueue,
    config.concurrency.tester,
    async (job, worker) => {
      const { item, spec, code } = job;
      if (cancelled) return;
      await waitWhilePaused();
      if (cancelled) return;
      emit({ type: "item.started", stage: "tester", itemId: item.id, worker });
      try {
        const s = states.get(item.id)!;
        const { testSource, result, failure } = await timed("tester", item.id, code.attempt, async () => {
          const authored = await agents.writeTests({
            spec,
            functionName: code.functionName,
            sourceCode: code.sourceCode,
            importPath: SOURCE_IMPORT,
          });
          s.testSource = authored.testSource;
          const attemptDir = path.join(runDir, item.id, `attempt-${code.attempt}`);
          const run = await runTests({
            dir: attemptDir,
            sourceCode: code.sourceCode,
            testSource: authored.testSource,
            timeoutMs: config.testTimeoutMs,
            signal,
            collectCoverage: config.gates.coverage,
          });

          // Unit tests are the first gate. Only if they pass do we run the rest.
          emit({ type: "item.gate", itemId: item.id, gate: "tests", passed: run.passed, detail: run.passed ? "" : firstLines(run.stderr || run.stdout) });
          let failure: string | null = run.passed ? null : formatFeedback(run.stdout, run.stderr);
          if (run.passed) failure = await runQualityGates(item.id, attemptDir, run);
          return { testSource: authored.testSource, result: run, failure };
        });
        void testSource;
        void result;
        if (cancelled) return;

        if (failure === null) {
          s.passed = true;
          emit({ type: "item.completed", stage: "tester", itemId: item.id, worker });
          await writeOutput(outputDir, item, code.functionName, code.sourceCode, testSource);
          finalize(item);
          return;
        }

        // Tests or a quality gate failed. Rework if attempts remain, else sink.
        const feedback = failure;
        s.lastError = feedback;
        if (code.attempt <= config.maxReworkAttempts) {
          const nextAttempt = code.attempt + 1;
          emit({ type: "item.reworked", itemId: item.id, attempt: nextAttempt, feedback });
          developerQueue.push({
            item,
            spec,
            attempt: nextAttempt,
            previousCode: code.sourceCode,
            feedback,
          });
          emit({ type: "item.enqueued", stage: "developer", itemId: item.id, queueDepth: developerQueue.depth });
        } else {
          emit({ type: "item.failed", itemId: item.id, stage: "tester", error: feedback });
          finalize(item);
        }
      } catch (err) {
        const s = states.get(item.id)!;
        s.lastError = errorMessage(err);
        emit({ type: "item.failed", itemId: item.id, stage: "tester", error: s.lastError });
        finalize(item);
      }
    },
  );

  // --- Run ------------------------------------------------------------------
  designerPool.start();
  developerPool.start();
  testerPool.start();

  // Honour a signal that was already aborted before we started.
  if (signal?.aborted) onAbort();

  if (!cancelled) {
    // Admit only DAG roots; dependents are enqueued by finalize() as their
    // dependencies pass (or cascade-failed if a dependency does not).
    for (const item of items) {
      if (item.dependsOn.length === 0) enqueueDesigner(item);
      else emit({ type: "item.blocked", itemId: item.id, dependsOn: item.dependsOn });
    }
  }

  await latch.done;
  signal?.removeEventListener("abort", onAbort);
  offCommand();

  // Every item is terminal: no worker is mid-flight and nothing will be pushed
  // again, so closing the queues just releases the idle pulls cleanly.
  designerQueue.close();
  developerQueue.close();
  testerQueue.close();
  await Promise.all([designerPool.drained(), developerPool.drained(), testerPool.drained()]);

  const finalRecords = items.map((it) => records.get(it.id)!);

  // Integration & packaging: assemble the passing modules into one library and
  // run a cross-module integration test. Skipped when cancelled.
  if (config.packaging.enabled && !cancelled) {
    const modules = finalRecords
      .filter((r) => r.passed && r.sourceCode !== null)
      .map((r) => ({
        functionName: designSpecs.get(r.workItem.id)?.functionName ?? r.workItem.id,
        sourceCode: r.sourceCode!,
      }));
    try {
      const pkg = await assemblePackage({
        outDir: path.join(outputDir, "package"),
        name: config.packaging.name,
        modules,
        timeoutMs: config.testTimeoutMs,
      });
      emit({ type: "pipeline.packaged", dir: pkg.dir, modules: pkg.modules, integrationPassed: pkg.integrationPassed });
    } catch (err) {
      emit({ type: "pipeline.packaged", dir: path.join(outputDir, "package"), modules: [], integrationPassed: false });
      void errorMessage(err);
    }
  }

  emit({ type: "pipeline.done", records: finalRecords });
  return finalRecords;
}

// --- Repo-editing mode -------------------------------------------------------
//
// A sibling of runPipeline that edits an EXISTING repository instead of
// generating standalone modules. It reuses every primitive (AsyncQueue,
// WorkerPool, CompletionLatch, the DAG finalize/cascade, the pause gate, the
// command channel) but swaps the three stage handlers: designRepo -> RepoDesignSpec,
// developRepo -> a multi-file Patch, and a tester that APPLIES the patch into a
// per-item working copy and runs the repository's OWN test/lint/build command.
// Per-item working copies give isolation, so items edit concurrently without
// conflicting. Module mode (runPipeline) is left byte-for-byte unchanged.
// (The control/DAG scaffolding is duplicated here to avoid touching the proven
//  module path; DRY-ing it behind a shared core is a noted follow-up.)

interface RepoDevJob {
  item: WorkItem;
  spec: RepoDesignSpec;
  attempt: number;
  feedback: string | null;
}
interface RepoTestJob {
  item: WorkItem;
  spec: RepoDesignSpec;
  patch: Patch;
}
interface RepoItemState {
  attempts: number;
  passed: boolean;
  patch: Patch | null;
  lastError: string | null;
}

function splitCommand(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.trim().split(/\s+/);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

async function runRepoPipeline(
  ctx: {
    config: PipelineConfig;
    agents: Agents;
    workspaceDir: string;
    bus: EventBus;
    commands: CommandBus;
  },
  prompt: string,
  opts: RunOptions = {},
): Promise<FinalRecord[]> {
  const { config, agents, workspaceDir, bus, commands } = ctx;
  if (!config.repo.source) throw new Error("repo mode requires config.repo.source (REPO_SOURCE)");
  if (!agents.designRepo || !agents.developRepo) {
    throw new Error("repo mode requires agents.designRepo and agents.developRepo");
  }
  const designRepo = agents.designRepo;
  const developRepo = agents.developRepo;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workspaceDir, "runs", runId);

  const designerQueue = new AsyncQueue<WorkItem>();
  const developerQueue = new AsyncQueue<RepoDevJob>();
  const testerQueue = new AsyncQueue<RepoTestJob>();

  const states = new Map<string, RepoItemState>();
  const records = new Map<string, FinalRecord>();
  const repoContexts = new Map<string, RepoContext>();
  const emit = (e: PipelineEvent) => bus.emit(e);

  emit({ type: "pipeline.started", runId, prompt, startedAt: Date.now() });

  const wbs = await agents.orchestrate(prompt, config.maxWbsItems);
  const raws = wbs.items.slice(0, config.maxWbsItems);
  const ids = raws.map((_, i) => `wi-${String(i + 1).padStart(3, "0")}`);
  const keyToId = new Map<string, string>();
  raws.forEach((raw, i) => {
    if (raw.key) keyToId.set(raw.key, ids[i]!);
  });
  const items: WorkItem[] = raws.map((raw, i) => {
    const self = ids[i]!;
    const deps = Array.from(
      new Set(
        (raw.dependsOn ?? [])
          .map((k) => keyToId.get(k))
          .filter((id): id is string => id !== undefined && id !== self),
      ),
    );
    return { id: self, title: raw.title, description: raw.description, acceptanceCriteria: raw.acceptanceCriteria, dependsOn: deps };
  });
  const itemsById = new Map(items.map((it) => [it.id, it]));
  assertAcyclic(items);

  const dependents = new Map<string, string[]>();
  const unmet = new Map<string, number>();
  for (const item of items) {
    states.set(item.id, { attempts: 0, passed: false, patch: null, lastError: null });
    unmet.set(item.id, item.dependsOn.length);
    for (const dep of item.dependsOn) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(item.id);
    }
  }
  emit({ type: "wbs.created", items });
  emit({ type: "repo.acquired", runId, root: runDir, ref: config.repo.ref });

  const latch = new CompletionLatch(items.length);

  const enqueueDesigner = (item: WorkItem) => {
    designerQueue.push(item);
    emit({ type: "item.enqueued", stage: "designer", itemId: item.id, queueDepth: designerQueue.depth });
  };

  let cancelled = false;
  let paused = false;
  const resumeWaiters: Array<() => void> = [];
  const waitWhilePaused = (): Promise<void> =>
    !paused || cancelled ? Promise.resolve() : new Promise<void>((r) => resumeWaiters.push(r));
  const drainResumeWaiters = () => {
    for (const r of resumeWaiters.splice(0)) r();
  };

  const finalize = (item: WorkItem) => {
    if (records.has(item.id)) return;
    const s = states.get(item.id)!;
    const record: FinalRecord = {
      workItem: item,
      passed: s.passed,
      attempts: s.attempts,
      sourceCode: null,
      testSource: null,
      lastError: s.lastError,
      patch: s.patch,
    };
    records.set(item.id, record);
    emit({ type: "item.finalized", record });
    latch.settleOne();
    for (const depId of dependents.get(item.id) ?? []) {
      if (records.has(depId)) continue;
      const dependent = itemsById.get(depId)!;
      if (s.passed) {
        const remaining = unmet.get(depId)! - 1;
        unmet.set(depId, remaining);
        if (remaining === 0 && !cancelled) {
          emit({ type: "item.unblocked", itemId: depId });
          enqueueDesigner(dependent);
        }
      } else {
        const ds = states.get(depId)!;
        ds.lastError = `blocked: dependency ${item.id} did not pass`;
        emit({ type: "item.failed", itemId: depId, stage: "designer", error: ds.lastError });
        finalize(dependent);
      }
    }
  };

  const cancelRun = (reason: string) => {
    if (cancelled) return;
    cancelled = true;
    paused = false;
    drainResumeWaiters();
    emit({ type: "pipeline.cancelled", reason });
    for (const item of items) {
      if (records.has(item.id)) continue;
      const s = states.get(item.id)!;
      if (s.lastError === null) s.lastError = "cancelled";
      finalize(item);
    }
  };
  const { signal } = opts;
  const onAbort = () => cancelRun(abortReason(signal));
  signal?.addEventListener("abort", onAbort, { once: true });

  const dispatchCommand = (cmd: PipelineCommand) => {
    switch (cmd.type) {
      case "run.cancel":
        cancelRun(cmd.reason || "cancelled by command");
        break;
      case "pipeline.pause":
        if (!paused && !cancelled) {
          paused = true;
          emit({ type: "pipeline.paused", at: Date.now() });
        }
        break;
      case "pipeline.resume":
        if (paused) {
          paused = false;
          emit({ type: "pipeline.resumed", at: Date.now() });
          drainResumeWaiters();
        }
        break;
      case "item.cancel": {
        const item = itemsById.get(cmd.itemId);
        if (!item || records.has(cmd.itemId)) {
          emit({ type: "command.rejected", command: cmd.type, itemId: cmd.itemId, reason: "unknown or already finalized item" });
          break;
        }
        const s = states.get(cmd.itemId)!;
        if (s.lastError === null) s.lastError = `skipped: ${cmd.reason}`;
        emit({ type: "item.skipped", itemId: cmd.itemId, reason: cmd.reason });
        finalize(item);
        break;
      }
      default: {
        const itemId = "itemId" in cmd ? cmd.itemId : null;
        emit({ type: "command.rejected", command: cmd.type, itemId, reason: "not supported yet" });
        break;
      }
    }
  };
  const offCommand = commands.onCommand(dispatchCommand);

  const designerPool = new WorkerPool<WorkItem>(designerQueue, config.concurrency.designer, async (item, worker) => {
    if (cancelled) return;
    await waitWhilePaused();
    if (cancelled) return;
    emit({ type: "item.started", stage: "designer", itemId: item.id, worker });
    try {
      const root = await prepareWorkingCopy(config.repo.source!, path.join(runDir, "wt", item.id), {
        ref: config.repo.ref,
        timeoutMs: config.testTimeoutMs,
      });
      const repo = createRepoContext(root);
      repoContexts.set(item.id, repo);
      const out = await designRepo({ item, repo });
      if (cancelled) return;
      const spec: RepoDesignSpec = { workItemId: item.id, ...out };
      emit({ type: "item.completed", stage: "designer", itemId: item.id, worker });
      developerQueue.push({ item, spec, attempt: 1, feedback: null });
      emit({ type: "item.enqueued", stage: "developer", itemId: item.id, queueDepth: developerQueue.depth });
    } catch (err) {
      const s = states.get(item.id)!;
      s.lastError = errorMessage(err);
      emit({ type: "item.failed", itemId: item.id, stage: "designer", error: s.lastError });
      finalize(item);
    }
  });

  const developerPool = new WorkerPool<RepoDevJob>(developerQueue, config.concurrency.developer, async (job, worker) => {
    const { item } = job;
    if (cancelled) return;
    await waitWhilePaused();
    if (cancelled) return;
    emit({ type: "item.started", stage: "developer", itemId: item.id, worker });
    try {
      const repo = repoContexts.get(item.id)!;
      const out = await developRepo({ spec: job.spec, repo, feedback: job.feedback, attempt: job.attempt });
      if (cancelled) return;
      const patch: Patch = { workItemId: item.id, summary: out.summary, edits: out.edits, attempt: job.attempt, feedback: job.feedback };
      const s = states.get(item.id)!;
      s.attempts = job.attempt;
      s.patch = patch;
      emit({ type: "item.patch.proposed", itemId: item.id, attempt: job.attempt, files: patch.edits.map((e) => e.path), summary: patch.summary });
      emit({ type: "item.completed", stage: "developer", itemId: item.id, worker });
      testerQueue.push({ item, spec: job.spec, patch });
      emit({ type: "item.enqueued", stage: "tester", itemId: item.id, queueDepth: testerQueue.depth });
    } catch (err) {
      const s = states.get(item.id)!;
      s.lastError = errorMessage(err);
      emit({ type: "item.failed", itemId: item.id, stage: "developer", error: s.lastError });
      finalize(item);
    }
  });

  const testerPool = new WorkerPool<RepoTestJob>(testerQueue, config.concurrency.tester, async (job, worker) => {
    const { item, patch } = job;
    if (cancelled) return;
    await waitWhilePaused();
    if (cancelled) return;
    emit({ type: "item.started", stage: "tester", itemId: item.id, worker });
    try {
      const repo = repoContexts.get(item.id)!;
      const s = states.get(item.id)!;
      const files = await applyEdits(repo.root, patch.edits);
      emit({ type: "item.patch.applied", itemId: item.id, attempt: patch.attempt, files });

      const checks = [config.repo.testCommand, config.repo.lintCommand, config.repo.buildCommand].filter(
        (c): c is string => Boolean(c),
      );
      let failure: string | null = null;
      for (const commandLine of checks) {
        const { command, args } = splitCommand(commandLine);
        const run = await runCommand({ cwd: repo.root, command, args, timeoutMs: config.testTimeoutMs, signal });
        emit({ type: "item.command", itemId: item.id, command: commandLine, passed: run.passed, detail: firstLines(run.stderr || run.stdout) });
        if (cancelled) return;
        if (!run.passed) {
          failure = formatFeedback(run.stdout, run.stderr);
          break;
        }
      }

      if (failure === null) {
        s.passed = true;
        emit({ type: "item.completed", stage: "tester", itemId: item.id, worker });
        finalize(item);
        return;
      }
      s.lastError = failure;
      if (patch.attempt <= config.maxReworkAttempts) {
        const nextAttempt = patch.attempt + 1;
        emit({ type: "item.reworked", itemId: item.id, attempt: nextAttempt, feedback: failure });
        developerQueue.push({ item, spec: job.spec, attempt: nextAttempt, feedback: failure });
        emit({ type: "item.enqueued", stage: "developer", itemId: item.id, queueDepth: developerQueue.depth });
      } else {
        emit({ type: "item.failed", itemId: item.id, stage: "tester", error: failure });
        finalize(item);
      }
    } catch (err) {
      const s = states.get(item.id)!;
      s.lastError = errorMessage(err);
      emit({ type: "item.failed", itemId: item.id, stage: "tester", error: s.lastError });
      finalize(item);
    }
  });

  designerPool.start();
  developerPool.start();
  testerPool.start();
  if (signal?.aborted) onAbort();
  if (!cancelled) {
    for (const item of items) {
      if (item.dependsOn.length === 0) enqueueDesigner(item);
      else emit({ type: "item.blocked", itemId: item.id, dependsOn: item.dependsOn });
    }
  }

  await latch.done;
  signal?.removeEventListener("abort", onAbort);
  offCommand();
  designerQueue.close();
  developerQueue.close();
  testerQueue.close();
  await Promise.all([designerPool.drained(), developerPool.drained(), testerPool.drained()]);

  const finalRecords = items.map((it) => records.get(it.id)!);
  emit({ type: "pipeline.done", records: finalRecords });
  return finalRecords;
}

/**
 * Validate the dependency graph is acyclic (Kahn's algorithm). A cycle would
 * leave items permanently blocked and deadlock the completion latch, so we fail
 * fast with a clear error rather than hang.
 */
function assertAcyclic(items: WorkItem[]): void {
  const indegree = new Map(items.map((it) => [it.id, it.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const it of items) {
    for (const dep of it.dependsOn) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(it.id);
    }
  }
  const queue = items.filter((it) => (indegree.get(it.id) ?? 0) === 0).map((it) => it.id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const n = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, n);
      if (n === 0) queue.push(dependent);
    }
  }
  if (processed !== items.length) {
    throw new Error("WBS dependency graph contains a cycle; cannot schedule items");
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason === undefined || reason === null) return "aborted";
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

async function writeOutput(
  outputDir: string,
  item: WorkItem,
  functionName: string,
  sourceCode: string,
  testSource: string,
): Promise<void> {
  const dir = path.join(outputDir, `${item.id}-${functionName}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, SOURCE_FILE), sourceCode, "utf8");
  await writeFile(path.join(dir, TEST_FILE), testSource, "utf8");
}

function formatFeedback(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((s) => s.trim().length > 0).join("\n");
  // Keep feedback bounded so it stays a tidy, serializable string in events.
  return combined.length > 4000 ? combined.slice(-4000) : combined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** First few non-empty lines of gate output, for a compact event detail. */
function firstLines(text: string, n = 6): string {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .join("\n");
}
