// Rendering tests (`npm run test:ui`): components mounted in jsdom with
// Testing Library. The pure-logic tests stay on node --test (`npm test`,
// `*.test.ts`); these are `*.test.tsx`. Setup and helpers: src/test/.
import { coverageConfigDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.tsx"],
      setupFiles: ["src/test/setup.ts"],
      css: false,
      restoreMocks: true,
      // A screen waits on its requests and its polling; a slow CI runner
      // gets more than the default 5s.
      testTimeout: 15_000,
      // `npm run test:ui:coverage` (CI runs it in place of `npm run
      // test:ui`): V8's own counters over the whole app, every file counted
      // whether a rendering test loads it or not. The thresholds are floors:
      // the measured values minus a small margin. Raise them when coverage
      // rises; never lower one to make a change pass (docs/process.md,
      // "Coverage"). The node --test suite has its own (`npm run
      // test:coverage`).
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          ...coverageConfigDefaults.exclude,
          // The tests' own helpers, server and fixtures.
          "src/test/**",
          "src/**/fixtures.ts",
          // Generated from the OpenAPI document (`npm run gen:api`).
          "src/lib/api-types.ts",
          // The translation tables: strings, not code.
          "src/i18n/locales/**",
          // The entry point: mounts the app into index.html's #root.
          "src/main.tsx",
        ],
        reporter: ["text-summary", "html", "lcov"],
        reportsDirectory: "coverage/ui",
        // Measured in CI on 2026-10-09: lines 65.22, branches 78.27,
        // functions 70.39, statements 65.22.
        thresholds: {
          lines: 64,
          branches: 77,
          functions: 69,
          statements: 64,
        },
      },
    },
  })
);
