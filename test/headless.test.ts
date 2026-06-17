/**
 * The engine boundary, enforced by a test (acceptance criterion #7, second half).
 *
 * The engine modules listed in §1a must import nothing from `vscode`, must not
 * touch CLI-only APIs (argv, stdout cursor control), must not import a renderer
 * or a terminal-UI lib, and must not print. A grep-style scan is enough.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// Exactly the modules §1a calls "the engine".
const ENGINE_FILES = [
  "src/engine.ts",
  "src/queue.ts",
  "src/sandbox.ts",
  "src/events.ts",
  "src/contracts.ts",
  "src/commands.ts",
  "src/repo.ts",
  "src/llm.ts",
  "src/agents/types.ts",
  "src/agents/prompts.ts",
  "src/agents/stub.ts",
  "src/agents/real.ts",
  "src/agents/mastra.ts",
  "src/agents/orchestrator.ts",
  "src/agents/designer.ts",
  "src/agents/developer.ts",
  "src/agents/tester.ts",
];

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /from\s+['"]vscode['"]/, why: "imports vscode" },
  { pattern: /from\s+['"][^'"]*renderers\//, why: "imports a renderer" },
  { pattern: /from\s+['"]log-update['"]/, why: "imports a terminal UI lib" },
  { pattern: /from\s+['"]picocolors['"]/, why: "imports a terminal colour lib" },
  { pattern: /process\.argv/, why: "reads process.argv" },
  { pattern: /process\.stdout\.(write|cursorTo|clearLine|moveCursor)/, why: "drives stdout cursor" },
  { pattern: /\bconsole\.(log|info|warn|error|debug)\b/, why: "prints to the console" },
];

describe("engine headlessness", () => {
  it("no engine module imports vscode, a renderer, or CLI-only APIs", async () => {
    const violations: string[] = [];
    for (const rel of ENGINE_FILES) {
      const src = await readFile(path.join(root, rel), "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(src)) violations.push(`${rel}: ${why}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
