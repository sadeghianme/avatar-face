import { defineConfig } from "vitest/config";

// `npm run test:browser`: the tests that drive real browsers (browser-tests/),
// one file at a time, each with its own browser.
export default defineConfig({
  test: {
    include: ["browser-tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
