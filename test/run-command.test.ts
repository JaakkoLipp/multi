/**
 * The generic command runner that repo mode uses to execute a repository's own
 * test/lint/build. Verifies exit-code reporting, timeout, and cooperative abort —
 * all deterministic and offline (just `node -e`).
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/sandbox.js";

const node = process.execPath;

describe("runCommand", () => {
  it("reports success for a zero exit", async () => {
    const r = await runCommand({ cwd: process.cwd(), command: node, args: ["-e", "process.exit(0)"], timeoutMs: 10_000 });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("reports the non-zero exit code", async () => {
    const r = await runCommand({ cwd: process.cwd(), command: node, args: ["-e", "process.exit(3)"], timeoutMs: 10_000 });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it("captures stdout and stderr", async () => {
    const r = await runCommand({
      cwd: process.cwd(),
      command: node,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      timeoutMs: 10_000,
    });
    expect(r.stdout).toContain("out");
    expect(r.stderr).toContain("err");
  });

  it("flags a timeout and kills the child", async () => {
    const r = await runCommand({
      cwd: process.cwd(),
      command: node,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 150,
    });
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("is killed by an aborted signal", async () => {
    const controller = new AbortController();
    const p = runCommand({
      cwd: process.cwd(),
      command: node,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const r = await p;
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(false); // aborted, not timed out
  });
});
