/**
 * Import-allowlist defense-in-depth for the test-execution sandbox.
 *
 * `findDisallowedImports` is unit-tested directly; `runTests` is exercised both
 * on the rejection path (no network, no vitest spawn) and the happy path (a
 * real vitest run under the project tree so `import "vitest"` resolves).
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDisallowedImports, runTests } from "../src/sandbox.js";
import { tmpWorkspace } from "./helpers.js";

describe("findDisallowedImports", () => {
  it("flags bare ES imports", () => {
    expect(findDisallowedImports(`import { readFileSync } from "fs"`)).toEqual(["fs"]);
  });

  it("flags node: builtins", () => {
    expect(findDisallowedImports(`import x from "node:fs"`)).toEqual(["node:fs"]);
  });

  it("flags require() of bare specifiers", () => {
    expect(findDisallowedImports(`const y = require("lodash")`)).toEqual(["lodash"]);
  });

  it("flags side-effect imports", () => {
    expect(findDisallowedImports(`import "leftpad"`)).toEqual(["leftpad"]);
  });

  it("returns [] for a clean self-contained module", () => {
    const clean = `export function add(a: number, b: number) { return a + b; }`;
    expect(findDisallowedImports(clean)).toEqual([]);
  });

  it("returns [] for relative imports", () => {
    expect(findDisallowedImports(`import { a } from "./util"`)).toEqual([]);
    expect(findDisallowedImports(`import { b } from "../util"`)).toEqual([]);
  });
});

describe("runTests rejection path", () => {
  it("rejects generated source with disallowed imports without executing", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const result = await runTests({
        dir: path.join(dir, "attempt"),
        sourceCode: `import { readFileSync } from "node:fs";\nexport function f() { return 1; }`,
        testSource: `import { expect, it } from "vitest";\nimport { f } from "./module";\nit("works", () => expect(f()).toBe(1));`,
        timeoutMs: 120_000,
      });
      expect(result.passed).toBe(false);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("disallowed imports");
      expect(result.stderr).toContain("node:fs");
    } finally {
      await cleanup();
    }
  });
});

describe("runTests happy path", () => {
  it("runs a clean self-contained module to passing", async () => {
    const { dir, cleanup } = await tmpWorkspace();
    try {
      const result = await runTests({
        dir: path.join(dir, "attempt"),
        sourceCode: `export function add(a: number, b: number) { return a + b; }`,
        testSource: [
          `import { expect, it } from "vitest";`,
          `import { add } from "./module";`,
          `it("adds", () => { expect(add(2, 3)).toBe(5); });`,
        ].join("\n"),
        timeoutMs: 120_000,
      });
      expect(result.passed).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
