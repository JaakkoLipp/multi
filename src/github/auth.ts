/**
 * GitHub App (bot identity) authentication.
 *
 * The app authenticates as a GitHub App *installation*: from the App's id +
 * private key we mint short-lived, installation-scoped tokens — never a static
 * PAT and never the harness's credentials. This is the "a dev team owns the repo"
 * identity: the bot posts as the App and has only the per-repo permissions the
 * installation granted.
 *
 * Wraps Octokit behind the narrow GitHubClient interface so the rest of the
 * integration stays mockable and network-free in tests.
 */
import { App } from "octokit";
import type { GitHubClient, IssueRef, RepoRef, ReviewFeedback } from "./client.js";

export interface GitHubAppConfig {
  appId: string | null;
  privateKey: string | null;
  installationId: number | null;
}

export function isGitHubConfigured(cfg: GitHubAppConfig): boolean {
  return Boolean(cfg.appId && cfg.privateKey && cfg.installationId);
}

export function assertGitHubConfigured(cfg: GitHubAppConfig): asserts cfg is {
  appId: string;
  privateKey: string;
  installationId: number;
} {
  if (!isGitHubConfigured(cfg)) {
    throw new Error(
      "GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY, and GITHUB_INSTALLATION_ID.",
    );
  }
}

export async function createGitHubAppClient(cfg: GitHubAppConfig): Promise<GitHubClient> {
  assertGitHubConfigured(cfg);
  const app = new App({ appId: Number(cfg.appId), privateKey: cfg.privateKey });
  const octokit = await app.getInstallationOctokit(cfg.installationId);

  return {
    async getIssue({ owner, repo, number }: IssueRef) {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
      return { number: data.number, title: data.title, body: data.body ?? "", htmlUrl: data.html_url };
    },
    async createComment({ owner, repo, number }: IssueRef, body: string) {
      const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
      return data.id;
    },
    async updateComment({ owner, repo }: RepoRef, commentId: number, body: string) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    },
    async createPull(args) {
      const { data } = await octokit.rest.pulls.create({
        owner: args.owner,
        repo: args.repo,
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
      });
      return { number: data.number, htmlUrl: data.html_url };
    },
    async getPullFeedback({ owner, repo }: RepoRef, pullNumber: number): Promise<ReviewFeedback> {
      const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      const [{ data: reviewComments }, { data: checks }] = await Promise.all([
        octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: pullNumber, per_page: 50 }),
        octokit.rest.checks.listForRef({ owner, repo, ref: pull.head.sha, per_page: 50 }),
      ]);
      const failing = checks.check_runs.filter(
        (c) => c.conclusion && ["failure", "timed_out", "action_required"].includes(c.conclusion),
      );
      const parts: string[] = [];
      for (const c of reviewComments) parts.push(`Review (${c.path ?? "general"}): ${c.body}`);
      for (const c of failing) parts.push(`Failing check "${c.name}": ${c.output?.summary ?? c.conclusion}`);
      return { text: parts.join("\n\n"), reviewComments: reviewComments.length, failingChecks: failing.length };
    },
    async installationToken() {
      const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
        installation_id: cfg.installationId,
      });
      return data.token;
    },
  };
}
