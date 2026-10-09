// ESLint for the embed: the recommended JavaScript and TypeScript rules,
// and the type-aware rules that catch what tsc does not: a promise nobody
// awaits or catches, a promise where a callback's result is ignored, and a
// switch over a union that misses a member.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // tsc's own convention: a leading underscore marks an unused binding
      // that has to exist (a parameter callers pass, a for-of over a stream).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  }
);
