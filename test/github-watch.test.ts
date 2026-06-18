/**
 * Closing the dev-team ownership loop, verified with a fake GitHubClient:
 *  - pollPullFeedback returns the first actionable feedback (failing checks or
 *    review comments) and stops polling once it finds it.
 *  - pollPullFeedback returns null when feedback never becomes actionable within
 *    the poll budget (bounded by maxPolls — never loops forever).
 *  - feedbackToPrompt composes a rework prompt from the original task + feedback.
 */
import { describe, expect, it } from "vitest";
import type {
  GitHubClient,
  IssueRef,
  PullData,
  RepoRef,
  ReviewFeedback,
} from "../src/github/client.js";
import { feedbackToPrompt, pollPullFeedback } from "../src/github/watch.js";

/**
 * A fake client whose `getPullFeedback` returns scripted values in order,
 * counting calls. Other methods are unused here and throw if touched.
 */
class FakeGitHub implements GitHubClient {
  calls = 0;
  constructor(private readonly script: ReviewFeedback[]) {}

  async getPullFeedback(_ref: RepoRef, _pullNumber: number): Promise<ReviewFeedback> {
    const i = Math.min(this.calls, this.script.length - 1);
    this.calls++;
    return this.script[i]!;
  }

  async getIssue(_ref: IssueRef): Promise<never> {
    throw new Error("not used");
  }
  async createComment(): Promise<number> {
    throw new Error("not used");
  }
  async updateComment(): Promise<void> {
    throw new Error("not used");
  }
  async createPull(): Promise<PullData> {
    throw new Error("not used");
  }
  async installationToken(): Promise<string> {
    throw new Error("not used");
  }
}

const empty: ReviewFeedback = { text: "", reviewComments: 0, failingChecks: 0 };
const ref: RepoRef = { owner: "acme", repo: "widgets" };
const noSleep = () => Promise.resolve();

describe("pollPullFeedback", () => {
  it("returns feedback once it becomes actionable, after a couple of empty polls", async () => {
    const actionable: ReviewFeedback = {
      text: "CI failed: lint errors in foo.ts",
      reviewComments: 1,
      failingChecks: 2,
    };
    const gh = new FakeGitHub([empty, empty, actionable]);

    const result = await pollPullFeedback(gh, ref, 7, { sleep: noSleep, maxPolls: 5 });

    expect(result).toEqual(actionable);
    expect(gh.calls).toBe(3); // two empty polls + one actionable
  });

  it("returns null when feedback never becomes actionable within maxPolls", async () => {
    const gh = new FakeGitHub([empty]);

    const result = await pollPullFeedback(gh, ref, 7, { sleep: noSleep, maxPolls: 5 });

    expect(result).toBeNull();
    expect(gh.calls).toBe(5); // exhausted the poll budget, did not loop forever
  });
});

describe("feedbackToPrompt", () => {
  it("includes the original task and the feedback text", () => {
    const feedback: ReviewFeedback = {
      text: "Please rename the variable and add a test.",
      reviewComments: 1,
      failingChecks: 0,
    };
    const prompt = feedbackToPrompt("Implement the widget sorter", feedback);

    expect(prompt).toContain("Implement the widget sorter");
    expect(prompt).toContain("Please rename the variable and add a test.");
  });
});
