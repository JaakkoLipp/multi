import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the project's own suite. The sandbox generates *.test.ts under
    // workspace/ at runtime; those must never be collected by the root runner.
    include: ["test/**/*.test.ts"],
    exclude: ["workspace/**", "node_modules/**"],
    // Each engine test spins up real vitest subprocesses; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
