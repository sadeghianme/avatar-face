// Rendering tests (`npm run test:ui`): components mounted in jsdom with
// Testing Library. The pure-logic tests stay on node --test (`npm test`,
// `*.test.ts`); these are `*.test.tsx`. Setup and helpers: src/test/.
import { defineConfig, mergeConfig } from "vitest/config";

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
    },
  })
);
