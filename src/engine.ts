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
  type Stage,
  type WorkItem,
} from "./contracts.js";
import { EventBus, type EventListener, type PipelineEvent } from "./events.js";
import { AsyncQueue, CompletionLatch, WorkerPool } from "./queue.js";
import { runTests, SOURCE_FILE, SOURCE_IMPORT, TEST_FILE } from "./sandbox.js";
import type { Agents } from "./agents/types.js";

export interface CreatePipelineOptions {
  config: PipelineConfig;
  agents: Agents;
  /** Where run artifacts + passing output are written. Defaults to ./workspace. */
  workspaceDir?: string;
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

  return {
    on: (l) => bus.on(l),
    events: () => bus.events(),
    run: (prompt, opts) => runPipeline({ config, agents, workspaceDir, bus }, prompt, opts),
  };
}

async function runPipeline(
  ctx: {
    config: PipelineConfig;
    agents: Agents;
    workspaceDir: string;
    bus: EventBus;
  },
  prompt: string,
  opts: RunOptions = {},
): Promise<FinalRecord[]> {
  const { config, agents, workspaceDir, bus } = ctx;
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workspaceDir, "runs", runId);
  const outputDir = path.join(workspaceDir, "output");

  const designerQueue = new AsyncQueue<WorkItem>();
  const developerQueue = new AsyncQueue<DevJob>();
  const testerQueue = new AsyncQueue<TestJob>();

  const states = new Map<string, ItemState>();
  const records = new Map<string, FinalRecord>();
  const emit = (e: PipelineEvent) => bus.emit(e);

  // --- WBS ------------------------------------------------------------------
  const wbs = await agents.orchestrate(prompt, config.maxWbsItems);
  const items: WorkItem[] = wbs.items.slice(0, config.maxWbsItems).map((raw, i) => ({
    id: `wi-${String(i + 1).padStart(3, "0")}`,
    title: raw.title,
    description: raw.description,
    acceptanceCriteria: raw.acceptanceCriteria,
  }));
  for (const item of items) {
    states.set(item.id, { attempts: 0, passed: false, sourceCode: null, testSource: null, lastError: null });
  }
  emit({ type: "wbs.created", items });

  const latch = new CompletionLatch(items.length);

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
    };
    records.set(item.id, record);
    emit({ type: "item.finalized", record });
    latch.settleOne();
  };

  // --- Cancellation ---------------------------------------------------------
  // On abort: stop scheduling new work, kill in-flight test runs (via the
  // signal threaded into the sandbox), and finalize everything still pending as
  // cancelled. That settles the latch, so run() resolves cleanly with records.
  const { signal } = opts;
  let cancelled = false;
  const onAbort = () => {
    if (cancelled) return;
    cancelled = true;
    emit({ type: "pipeline.cancelled", reason: abortReason(signal) });
    for (const item of items) {
      if (records.has(item.id)) continue;
      const s = states.get(item.id)!;
      if (s.lastError === null) s.lastError = "cancelled";
      finalize(item);
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

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

  // --- Designer stage -------------------------------------------------------
  const designerPool = new WorkerPool<WorkItem>(
    designerQueue,
    config.concurrency.designer,
    async (item, worker) => {
      if (cancelled) return;
      emit({ type: "item.started", stage: "designer", itemId: item.id, worker });
      try {
        const out = await timed("designer", item.id, 1, () => agents.design(item));
        if (cancelled) return;
        const spec: DesignSpec = { workItemId: item.id, ...out };
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
      emit({ type: "item.started", stage: "developer", itemId: item.id, worker });
      try {
        const out = await timed("developer", item.id, job.attempt, () =>
          agents.develop({
            spec: job.spec,
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
      emit({ type: "item.started", stage: "tester", itemId: item.id, worker });
      try {
        const s = states.get(item.id)!;
        const { testSource, result } = await timed("tester", item.id, code.attempt, async () => {
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
          });
          return { testSource: authored.testSource, result: run };
        });
        void testSource;
        if (cancelled) return;

        if (result.passed) {
          s.passed = true;
          emit({ type: "item.completed", stage: "tester", itemId: item.id, worker });
          await writeOutput(outputDir, item, code.functionName, code.sourceCode, testSource);
          finalize(item);
          return;
        }

        // Failed. Rework if we still have attempts left, else sink as failed.
        const feedback = formatFeedback(result.stdout, result.stderr);
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
    for (const item of items) {
      designerQueue.push(item);
      emit({ type: "item.enqueued", stage: "designer", itemId: item.id, queueDepth: designerQueue.depth });
    }
  }

  await latch.done;
  signal?.removeEventListener("abort", onAbort);

  // Every item is terminal: no worker is mid-flight and nothing will be pushed
  // again, so closing the queues just releases the idle pulls cleanly.
  designerQueue.close();
  developerQueue.close();
  testerQueue.close();
  await Promise.all([designerPool.drained(), developerPool.drained(), testerPool.drained()]);

  const finalRecords = items.map((it) => records.get(it.id)!);
  emit({ type: "pipeline.done", records: finalRecords });
  return finalRecords;
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
