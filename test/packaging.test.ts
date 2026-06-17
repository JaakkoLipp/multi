/**
 * Integration & packaging stage: passing modules are assembled into one library
 * (barrel + package.json + README) and a real cross-module integration test is
 * executed. Verified both directly (assemblePackage) and end-to-end (engine
 * emits pipeline.packaged with the integration verdict).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStubAgents } from "../src/agents/stub.js";
import { loadConfig } from "../src/config.js";
import { createPipeline } from "../src/engine.js";
import type { PipelineEvent } from "../src/events.js";
import { assemblePackage } from "../src/packager.js";
import { tmpWorkspace } from "./helpers.js";

describe("assemblePackage", () => {
  it("builds a barrel + integration test that passes for valid modules", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const out = path.join(dir, "pkg");
      const result = await assemblePackage({
        outDir: out,
        name: "demo-utils",
        timeoutMs: 60_000,
        modules: [
          { functionName: "double", sourceCode: "export function double(n: number): number { return n * 2; }\n" },
          { functionName: "shout", sourceCode: "export function shout(s: string): string { return s.toUpperCase(); }\n" },
        ],
      });

      expect(result.modules.sort()).toEqual(["double", "shout"]);
      expect(result.integrationPassed).toBe(true);

      const barrel = await readFile(path.join(out, "index.ts"), "utf8");
      expect(barrel).toContain(`export * from "./src/double.js";`);
      expect(barrel).toContain(`export * from "./src/shout.js";`);

      const pkgJson = JSON.parse(await readFile(path.join(out, "package.json"), "utf8"));
      expect(pkgJson.name).toBe("demo-utils");
      expect(pkgJson.type).toBe("module");
    } finally {
      await cleanup();
    }
  }, 120_000);

  it("deduplicates colliding function names", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const result = await assemblePackage({
        outDir: path.join(dir, "pkg"),
        name: "dupes",
        timeoutMs: 60_000,
        modules: [
          { functionName: "f", sourceCode: "export function f(): number { return 1; }\n" },
          { functionName: "f", sourceCode: "export function f(): number { return 2; }\n" },
        ],
      });
      expect(result.modules).toEqual(["f"]);
      expect(result.integrationPassed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

describe("packaging (engine end-to-end)", () => {
  it("emits pipeline.packaged with a passing integration test", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const config = loadConfig({ MAX_WBS_ITEMS: "3" });
      config.packaging.enabled = true;
      const pipeline = createPipeline({ config, agents: createStubAgents(), workspaceDir: dir });
      const events: PipelineEvent[] = [];
      pipeline.on((e) => events.push(e));

      await pipeline.run("string utils");

      const packaged = events.find((e) => e.type === "pipeline.packaged");
      expect(packaged).toBeDefined();
      if (packaged?.type === "pipeline.packaged") {
        expect(packaged.integrationPassed).toBe(true);
        expect(packaged.modules.length).toBe(3);
      }
      // pipeline.packaged must precede pipeline.done.
      const packagedIdx = events.findIndex((e) => e.type === "pipeline.packaged");
      const doneIdx = events.findIndex((e) => e.type === "pipeline.done");
      expect(packagedIdx).toBeLessThan(doneIdx);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
