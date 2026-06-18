/**
 * The narrow GitHub surface the app actually uses. Everything in src/github/*
 * (tracker, source, pr, watch) depends on this interface, NOT on Octokit
 * directly — so the whole GitHub integration is unit-testable with a fake client
 * and no network/token. The real implementation (auth.ts) wraps an Octokit
 * authenticated as a GitHub App installation.
 *
 * This is application code (a consumer of the engine's event stream + a sink to
 * GitHub). It is NOT an engine module and is never imported by the engine.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueRef extends RepoRef {
  number: number;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
}

export interface PullData {
  number: number;
  htmlUrl: string;
}

export interface ReviewFeedback {
  /** Aggregated, human-readable feedback from review comments + failing checks. */
  text: string;
  reviewComments: number;
  failingChecks: number;
}

export interface GitHubClient {
  getIssue(ref: IssueRef): Promise<IssueData>;
  createComment(ref: IssueRef, body: string): Promise<number>; // returns comment id
  updateComment(ref: RepoRef, commentId: number, body: string): Promise<void>;
  createPull(args: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullData>;
  /** Aggregate open review comments + failing check runs for a PR (CI/review loop). */
  getPullFeedback(ref: RepoRef, pullNumber: number): Promise<ReviewFeedback>;
  /** A short-lived installation token for git push (https://x-access-token:<token>@...). */
  installationToken(): Promise<string>;
}
