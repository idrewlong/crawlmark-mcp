import { defineConfig } from "vitest/config";

/**
 * `npm run test:live` (vitest run -c test/live/vitest.config.ts): the opt-in smoke runner. It reads the user's real
 * configuration (no test/setup.ts isolation) and calls free endpoints only. Not part of `npm test`
 * (vitest.config.ts includes `*.test.ts` only) and not part of CI.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    setupFiles: ["test/live/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
