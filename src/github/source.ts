/**
 * Input seam: a GitHub issue becomes the task that drives a run.
 *
 * `--issue owner/repo#123` is parsed here; the issue's title + body become the
 * run prompt (and, in repo mode, the target repository is that issue's repo).
 */
import type { IssueData, IssueRef } from "./client.js";

export function parseIssueRef(spec: string): IssueRef {
  const m = spec.trim().match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!m) throw new Error(`Invalid issue reference "${spec}". Expected "owner/repo#number".`);
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** Build the run prompt from an issue. Title is the headline; body adds detail. */
export function issueToPrompt(issue: IssueData): string {
  const body = issue.body.trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}
