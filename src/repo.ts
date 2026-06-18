/**
 * Repo-mode working copy + context provider.
 *
 * In repo mode the "workspace" for an item is a working copy of an existing
 * repository. This module (a) materializes that working copy, (b) gives agents a
 * read-only `RepoContext` (file tree, search, read) so they can reason about real
 * code, and (c) applies a multi-file `Patch` into the working copy.
 *
 * MVP: the working copy is a filesystem copy and search is a dependency-free JS
 * scan — enough to run and test repo mode offline. Real `git clone`/worktree
 * isolation and `ripgrep` land with the GitHub/PR phase (see DECISIONS).
 *
 * Headless (engine module): imports nothing from `vscode`/CLI, prints nothing.
 * Subprocess work goes through the sandbox's runCommand primitive.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileEdit } from "./contracts.js";
import { runCommand } from "./sandbox.js";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface RepoContext {
  /** Absolute path to this item's working copy. */
  root: string;
  /** Repo-relative POSIX paths of all (non-ignored) files. */
  listFiles(): Promise<string[]>;
  /** Naive substring/regex search across text files. */
  search(pattern: string): Promise<SearchHit[]>;
  /** Read a repo-relative file. */
  read(relPath: string): Promise<string>;
}

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".vitest"]);
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Materialize a working copy of `source` at `dest` and return its root.
 *
 * A remote URL (http(s)/git@/ssh) is `git clone`d at the given ref; a local path
 * is copied (used by the offline test fixture). For private repos the caller
 * embeds an installation token in the URL.
 */
export async function prepareWorkingCopy(
  source: string,
  dest: string,
  opts: { ref?: string; timeoutMs?: number } = {},
): Promise<string> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });

  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source)) {
    const args = ["clone", "--depth", "1"];
    if (opts.ref) args.push("--branch", opts.ref);
    args.push(source, dest);
    const r = await runCommand({
      cwd: path.dirname(dest),
      command: "git",
      args,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    if (!r.passed) throw new Error(`git clone failed: ${r.stderr || r.stdout}`);
    return dest;
  }

  await cp(source, dest, {
    recursive: true,
    filter: (src) => !src.split(path.sep).some((seg) => IGNORED.has(seg)),
  });
  return dest;
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, childRel)));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

export function createRepoContext(root: string): RepoContext {
  return {
    root,
    listFiles: () => walk(root),
    read: (relPath) => readFile(path.join(root, relPath), "utf8"),
    async search(pattern) {
      const re = new RegExp(pattern);
      const hits: SearchHit[] = [];
      for (const rel of await walk(root)) {
        const abs = path.join(root, rel);
        const info = await stat(abs);
        if (info.size > MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = await readFile(abs, "utf8");
        } catch {
          continue; // binary / unreadable
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) hits.push({ path: rel, line: i + 1, text: lines[i]! });
        }
      }
      return hits;
    },
  };
}

/** Apply a set of file edits into the working copy. Returns the touched paths. */
export async function applyEdits(root: string, edits: FileEdit[]): Promise<string[]> {
  const touched: string[] = [];
  for (const edit of edits) {
    const abs = path.join(root, edit.path);
    if (edit.kind === "delete") {
      await rm(abs, { force: true });
    } else {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, edit.contents ?? "", "utf8");
    }
    touched.push(edit.path);
  }
  return touched;
}
