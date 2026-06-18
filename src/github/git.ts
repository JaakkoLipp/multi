/**
 * Git operations for opening a PR from a finished repo-mode run.
 *
 * Clones the target repo with a short-lived installation token, creates a branch,
 * applies every passing item's patch, commits, and pushes. Real-environment only:
 * in the harness sandbox git is brokered through a local proxy and no token is
 * present, so this is exercised against real GitHub (like the live LLM path).
 *
 * Uses the generic runCommand sandbox primitive — no shell, args passed directly.
 */
import path from "node:path";
import type { FinalRecord } from "../contracts.js";
import { applyEdits } from "../repo.js";
import { runCommand } from "../sandbox.js";

export interface PreparePrBranchArgs {
  owner: string;
  repo: string;
  token: string;
  baseRef: string;
  branch: string;
  workdir: string; // where to clone
  records: FinalRecord[];
  commitMessage: string;
  timeoutMs: number;
}

export interface PrBranchResult {
  branch: string;
  pushed: boolean;
  filesChanged: string[];
  log: string;
}

export async function preparePrBranch(args: PreparePrBranchArgs): Promise<PrBranchResult> {
  const authUrl = `https://x-access-token:${args.token}@github.com/${args.owner}/${args.repo}.git`;
  const log: string[] = [];
  const run = async (command: string, cmdArgs: string[], cwd: string) => {
    const r = await runCommand({ cwd, command, args: cmdArgs, timeoutMs: args.timeoutMs });
    log.push(`$ ${command} ${cmdArgs.join(" ")}\n${r.stdout}${r.stderr}`);
    if (!r.passed) throw new Error(`git step failed: ${command} ${cmdArgs.join(" ")}\n${r.stderr}`);
    return r;
  };

  const clone = path.join(args.workdir, args.repo);
  await run("git", ["clone", "--depth", "1", "--branch", args.baseRef, authUrl, clone], args.workdir);
  await run("git", ["checkout", "-b", args.branch], clone);

  const filesChanged: string[] = [];
  for (const record of args.records) {
    if (record.passed && record.patch) {
      filesChanged.push(...(await applyEdits(clone, record.patch.edits)));
    }
  }

  await run("git", ["config", "user.email", "agent-pipeline[bot]@users.noreply.github.com"], clone);
  await run("git", ["config", "user.name", "agent-pipeline[bot]"], clone);
  await run("git", ["add", "-A"], clone);
  await run("git", ["commit", "-m", args.commitMessage], clone);
  const push = await runCommand({
    cwd: clone,
    command: "git",
    args: ["push", "-u", "origin", args.branch],
    timeoutMs: args.timeoutMs,
  });

  return {
    branch: args.branch,
    pushed: push.passed,
    filesChanged: Array.from(new Set(filesChanged)),
    log: log.join("\n\n"),
  };
}
