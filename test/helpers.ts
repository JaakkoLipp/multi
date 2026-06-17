import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * A throwaway workspace UNDER the project tree. It must live inside the project
 * so the sandbox's generated `*.test.ts` specs (ESM `import "vitest"`) resolve
 * against the project's node_modules — bare-specifier resolution walks up the
 * directory tree, so a /tmp location would not find vitest.
 */
export async function tmpWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = path.join(projectRoot, "workspace", ".test-runs");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "ws-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
