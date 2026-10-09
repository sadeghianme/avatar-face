import { coverageConfigDefaults, defineConfig } from "vitest/config";

// `npm test`: everything but the browser tests, which need Chromium
// (browser-tests/, `npm run test:browser`, vitest.browser.config.ts).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "dist/**", "browser-tests/**"],
    // `npm run test:coverage` (CI runs it in place of `npm test`): V8's own
    // counters, no instrumented build. Every source file counts, loaded by a
    // test or not. The thresholds are floors: the measured values minus a
    // small margin. Raise them when coverage rises; never lower one to make a
    // change pass (docs/process.md, "Coverage").
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Generated from the OpenAPI document (scripts/gen-api-types.mjs).
        "src/api-types.ts",
        // The 3D head's manual harness page (a developer tool, not shipped).
        "src/head3d/harness/**",
      ],
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 89,
        branches: 88,
        functions: 86,
        statements: 89,
      },
    },
  },
});
