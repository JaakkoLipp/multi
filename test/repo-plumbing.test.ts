/**
 * Repo-mode plumbing (Phase 3), proven before the engine is rewired (Phase 4):
 * materialize a working copy of a real (buggy) fixture repo, use the RepoContext
 * to read/search it, let the stub repo-agents design + patch it, apply the patch,
 * and run the repo's OWN test command — failing on the first attempt and passing
 * after rework with the real failing output as feedback.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import type { RepoDesignSpec } from "../src/contracts.js";
import { applyEdits, createRepoContext, prepareWorkingCopy } from "../src/repo.js";
import { runCommand } from "../src/sandbox.js";
import { tmpWorkspace } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/repo", import.meta.url));
const node = process.execPath;

describe("repo-mode plumbing", () => {
  it("materializes a working copy and exposes a read/search context", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const root = await prepareWorkingCopy(fixture, path.join(dir, "wc"));
      const repo = createRepoContext(root);

      expect((await repo.listFiles()).sort()).toEqual(["src.mjs", "test.mjs"]);
      expect(await repo.read("src.mjs")).toContain("function add");
      const hits = await repo.search("return a");
      expect(hits.some((h) => h.path === "src.mjs")).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it("fixes a real repo via design -> patch -> run its own tests, with rework", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const agents = createStubAgents();
      const root = await prepareWorkingCopy(fixture, path.join(dir, "wc"));
      const repo = createRepoContext(root);

      const item = { id: "wi-001", title: "fix add", description: "", acceptanceCriteria: [], dependsOn: [] };
      const design = await agents.designRepo!({ item, repo });
      const spec: RepoDesignSpec = { workItemId: item.id, ...design };

      // Attempt 1: still wrong -> the repo's own test fails.
      const patch1 = await agents.developRepo!({ spec, repo, feedback: null, attempt: 1 });
      await applyEdits(root, patch1.edits);
      const run1 = await runCommand({ cwd: root, command: node, args: ["test.mjs"], timeoutMs: 30_000 });
      expect(run1.passed).toBe(false);

      // Attempt 2: rework with the real failing output -> passes.
      const patch2 = await agents.developRepo!({ spec, repo, feedback: run1.stderr || run1.stdout, attempt: 2 });
      await applyEdits(root, patch2.edits);
      const run2 = await runCommand({ cwd: root, command: node, args: ["test.mjs"], timeoutMs: 30_000 });
      expect(run2.passed).toBe(true);
      expect(run2.stdout).toContain("ok");

      // The fix is real and isolated to the working copy (fixture untouched).
      expect(await repo.read("src.mjs")).toContain("a + b");
    } finally {
      await cleanup();
    }
  }, 60_000);
});
