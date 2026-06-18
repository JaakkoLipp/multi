/**
 * GitHub dev-team ownership, verified with a fake GitHubClient (no network/token):
 *  - source: an issue reference parses and becomes a run prompt.
 *  - tracker: a single tracking comment is posted on wbs.created and live-edited
 *    as items progress (the "dev team working the issue" behaviour).
 *  - pr: the PR body is built from the run summary and links the issue.
 */
import { describe, expect, it } from "vitest";
import type { FinalRecord } from "../src/contracts.js";
import type { EventListener, PipelineEvent } from "../src/events.js";
import type { GitHubClient, IssueRef, PullData, ReviewFeedback } from "../src/github/client.js";
import { openPullRequest, renderPullBody } from "../src/github/pr.js";
import { issueToPrompt, parseIssueRef } from "../src/github/source.js";
import { attachTracker } from "../src/github/tracker.js";
import type { RunSummary } from "../src/metrics.js";

/** A fake client recording every call. */
class FakeGitHub implements GitHubClient {
  comments: Array<{ id: number; body: string }> = [];
  updates: Array<{ id: number; body: string }> = [];
  pulls: Array<{ title: string; head: string; base: string; body: string }> = [];
  private nextId = 100;

  async getIssue(ref: IssueRef) {
    return { number: ref.number, title: "Fix the thing", body: "It is broken.", htmlUrl: "https://x/1" };
  }
  async createComment(_ref: IssueRef, body: string): Promise<number> {
    const id = this.nextId++;
    this.comments.push({ id, body });
    return id;
  }
  async updateComment(_ref: { owner: string; repo: string }, commentId: number, body: string): Promise<void> {
    this.updates.push({ id: commentId, body });
  }
  async createPull(args: { owner: string; repo: string; title: string; head: string; base: string; body: string }): Promise<PullData> {
    this.pulls.push({ title: args.title, head: args.head, base: args.base, body: args.body });
    return { number: 7, htmlUrl: "https://x/pull/7" };
  }
  async getPullFeedback(): Promise<ReviewFeedback> {
    return { text: "", reviewComments: 0, failingChecks: 0 };
  }
  async installationToken(): Promise<string> {
    return "ghs_faketoken";
  }
}

/** A synchronous test event source mimicking pipeline.on. */
function makeSource() {
  const listeners = new Set<EventListener>();
  return {
    on: (l: EventListener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fire: (e: PipelineEvent) => {
      for (const l of listeners) l(e);
    },
  };
}

const item = (id: string, title: string) => ({ id, title, description: "", acceptanceCriteria: [], dependsOn: [] });
const record = (id: string, title: string, passed: boolean, attempts: number): FinalRecord => ({
  workItem: item(id, title),
  passed,
  attempts,
  sourceCode: null,
  testSource: null,
  lastError: passed ? null : "boom",
  patch: null,
});

describe("github source", () => {
  it("parses an issue reference", () => {
    expect(parseIssueRef("acme/widgets#42")).toEqual({ owner: "acme", repo: "widgets", number: 42 });
    expect(() => parseIssueRef("not-an-issue")).toThrow();
  });
  it("builds a prompt from an issue", () => {
    expect(issueToPrompt({ number: 1, title: "T", body: "B", htmlUrl: "" })).toBe("T\n\nB");
    expect(issueToPrompt({ number: 1, title: "T", body: "", htmlUrl: "" })).toBe("T");
  });
});

describe("github tracker", () => {
  it("posts one comment then live-edits it as items progress", async () => {
    const gh = new FakeGitHub();
    const src = makeSource();
    const ref: IssueRef = { owner: "acme", repo: "widgets", number: 42 };
    const tracker = attachTracker(src.on, gh, ref);

    // WBS posts the initial comment.
    src.fire({ type: "wbs.created", items: [item("wi-001", "alpha"), item("wi-002", "beta")] });
    await tracker.idle();
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("0/2");

    // Progress edits the SAME comment (no new comments).
    src.fire({ type: "item.started", stage: "developer", itemId: "wi-001", worker: 0 });
    await tracker.idle();
    src.fire({ type: "item.finalized", record: record("wi-001", "alpha", true, 1) });
    src.fire({ type: "item.finalized", record: record("wi-002", "beta", false, 3) });
    src.fire({ type: "pipeline.done", records: [] });
    await tracker.idle();

    expect(gh.comments).toHaveLength(1); // still exactly one comment
    expect(gh.updates.length).toBeGreaterThanOrEqual(1);
    const finalBody = gh.updates.at(-1)!.body;
    expect(finalBody).toContain("finished");
    expect(finalBody).toContain("**wi-001** alpha — ✅ passed");
    expect(finalBody).toContain("**wi-002** beta — ❌ failed");
    expect(finalBody).toContain("2/2"); // all items done
    expect(finalBody).toContain("1 passed");
    tracker.detach();
  });
});

describe("github pr", () => {
  const summary: RunSummary = {
    runId: "r1",
    prompt: "fix",
    total: 2,
    passed: 1,
    failed: 1,
    reworks: 2,
    cancelled: false,
    cancelReason: null,
    busyMs: 0,
    perStage: {
      designer: { runs: 0, totalMs: 0, maxMs: 0 },
      developer: { runs: 0, totalMs: 0, maxMs: 0 },
      tester: { runs: 0, totalMs: 0, maxMs: 0 },
    },
    items: [],
  };
  const records = [record("wi-001", "alpha", true, 1), record("wi-002", "beta", false, 3)];

  it("renders a PR body that links the issue and tabulates results", () => {
    const body = renderPullBody(summary, records, 42);
    expect(body).toContain("Closes #42");
    expect(body).toContain("1/2");
    expect(body).toContain("| wi-001 | alpha | ✅ | 1 |");
    expect(body).toContain("| wi-002 | beta | ❌ | 3 |");
  });

  it("opens a PR via the client with that body", async () => {
    const gh = new FakeGitHub();
    const pull = await openPullRequest(gh, {
      owner: "acme",
      repo: "widgets",
      title: "Resolve #42",
      head: "agent/issue-42-1",
      base: "main",
      summary,
      records,
      issueNumber: 42,
    });
    expect(pull.htmlUrl).toContain("/pull/7");
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]!.body).toContain("Closes #42");
    expect(gh.pulls[0]!.head).toBe("agent/issue-42-1");
  });
});
