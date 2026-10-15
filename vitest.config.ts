import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // GitHub's Windows runners take about twice as long to load modules and spawn processes, and a different
    // test hit the 5 s default on each run. Other platforms keep vitest's defaults (5 s tests, 10 s hooks).
    ...(process.platform === "win32" ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
  },
});
