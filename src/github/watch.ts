/**
 * Closing the dev-team ownership loop: PR CI/review -> follow-up rework.
 *
 * After a run opens a pull request (see pr.ts), the "dev team" isn't done — CI
 * may fail and reviewers may leave comments. This module watches a PR for that
 * actionable feedback and turns it into a fresh rework prompt, so a caller can
 * kick off another pipeline run that addresses the failures.
 *
 * Like the rest of src/github/*, this is application code: a pure, injectable
 * consumer of the GitHubClient interface (NOT an engine module, never imported
 * by the engine). It hard-codes no real timers or network — polling cadence and
 * the sleep primitive are injectable so tests are fast and deterministic.
 *
 * The actual re-run wiring (taking the composed prompt and starting a new
 * pipeline) lives in the CLI — `watchAndRework` documents that seam by taking a
 * `runRework` callback rather than reaching into the engine itself.
 */
import type { GitHubClient, RepoRef, ReviewFeedback } from "./client.js";

/** Default cadence between feedback polls (~15s). */
const DEFAULT_INTERVAL_MS = 15_000;
/** Default cap on polls so the loop can never run forever (~10min at 15s). */
const DEFAULT_MAX_POLLS = 40;

/** A real, cancellable-free sleep used in production; tests inject a no-op. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WatchOptions {
  /** Milliseconds to wait between polls. Default ~15000. */
  intervalMs?: number;
  /** Maximum number of polls before giving up. Default ~40. */
  maxPolls?: number;
  /** Sleep primitive; injected as `() => Promise.resolve()` in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Feedback is "actionable" when there is something to rework: either CI has
 * failing checks or a human left review comments.
 */
export function isActionable(feedback: ReviewFeedback): boolean {
  return feedback.failingChecks > 0 || feedback.reviewComments > 0;
}

/**
 * Poll `client.getPullFeedback(ref, pullNumber)` up to `maxPolls` times,
 * sleeping `intervalMs` between attempts, and return the first actionable
 * `ReviewFeedback`. Returns `null` if no actionable feedback arrives within
 * `maxPolls`. The poll count is bounded, so this never loops forever.
 *
 * The sleep happens between polls only (not after the last poll), so with
 * `maxPolls: N` the client is called exactly up to N times.
 */
export async function pollPullFeedback(
  client: GitHubClient,
  ref: RepoRef,
  pullNumber: number,
  opts: WatchOptions = {},
): Promise<ReviewFeedback | null> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS;
  const sleep = opts.sleep ?? realSleep;

  for (let poll = 0; poll < maxPolls; poll++) {
    if (poll > 0) await sleep(intervalMs);
    const feedback = await client.getPullFeedback(ref, pullNumber);
    if (isActionable(feedback)) return feedback;
  }
  return null;
}

/**
 * Compose a follow-up rework prompt: the original task, plus a clearly
 * delimited section carrying the PR's failing checks / review comments and an
 * instruction to address them. Returns a plain string (the next run's prompt).
 */
export function feedbackToPrompt(originalTask: string, feedback: ReviewFeedback): string {
  const detail = feedback.text.trim() || "(no detail provided)";
  return [
    originalTask.trim(),
    "",
    "---",
    "## Pull request feedback to address",
    "",
    `The pull request opened for this task received feedback: ${feedback.failingChecks} failing check(s) and ${feedback.reviewComments} review comment(s). Rework the implementation so that all checks pass and the review comments are resolved.`,
    "",
    detail,
  ].join("\n");
}

/**
 * Thin orchestration seam: watch a PR for actionable feedback and, if any
 * arrives, hand a composed rework prompt to `runRework`. The caller (the CLI)
 * supplies `runRework` to start a new pipeline run — that wiring deliberately
 * lives outside this module so watch.ts stays engine-free and unit-testable.
 *
 * Returns `true` if rework was triggered, `false` if no actionable feedback
 * appeared within the poll budget.
 */
export async function watchAndRework(
  client: GitHubClient,
  ref: RepoRef,
  pullNumber: number,
  originalTask: string,
  runRework: (prompt: string) => Promise<void>,
  opts?: WatchOptions,
): Promise<boolean> {
  const feedback = await pollPullFeedback(client, ref, pullNumber, opts);
  if (!feedback) return false;
  await runRework(feedbackToPrompt(originalTask, feedback));
  return true;
}
