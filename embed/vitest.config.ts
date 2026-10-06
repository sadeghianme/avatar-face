import { defineConfig } from "vitest/config";

// `npm test`: everything but the browser tests, which need Chromium
// (browser-tests/, `npm run test:browser`, vitest.browser.config.ts).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "dist/**", "browser-tests/**"],
  },
});
