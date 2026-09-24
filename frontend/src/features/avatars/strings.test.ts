/**
 * Every literal translation key the wizard's features use exists in every
 * language: `npm test` (node --test). A missing key renders as the key
 * itself ("adjustFix") and TypeScript cannot see it, since `t` takes any
 * string. Keys built at runtime (`adjustMode_${mode}`) are checked against
 * their code lists in creation.test.ts.
 *
 * Source and locales are read as text: importing a locale would climb out
 * of this feature, which the structure check forbids.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
// The features M4 touched; the lab has keys of its own, kept apart.
const FEATURES = ["features/avatars", "features/settings", "features/share"];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

function localeKeys(lang) {
  const dir = join(SRC, "i18n/locales", lang);
  const keys = new Set();
  for (const file of readdirSync(dir)) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/^\s{2}([A-Za-z0-9_]+):\s/gm)) keys.add(m[1]);
  }
  return keys;
}

const used = new Set();
for (const feature of FEATURES) {
  for (const file of walk(join(SRC, feature))) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) used.add(m[1]);
  }
}

describe("translation keys", () => {
  for (const lang of ["en", "fr"]) {
    it(`are all defined in ${lang}`, () => {
      const keys = localeKeys(lang);
      // A key used with a count may exist only in its plural forms.
      const missing = [...used].filter((key) => !keys.has(key) && !keys.has(`${key}_one`));
      assert.deepEqual(missing, []);
    });
  }
});
