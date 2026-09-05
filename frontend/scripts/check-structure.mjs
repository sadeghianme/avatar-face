#!/usr/bin/env node
/**
 * Structure rules, enforced. Runs before every build (`npm run check`).
 *
 * A folder layout is only scalable while its boundaries hold, and boundaries
 * that live in a README erode one "quick import" at a time. These are the
 * three rules that keep `src/` legible as it grows — see src/README.md.
 *
 *  1. Features are black boxes. Code outside `features/<x>/` may import
 *     `@/features/<x>` (its index.ts) and nothing deeper.
 *  2. Shared layers never depend on features: `components/`, `lib/`,
 *     `providers/` and `i18n/` must not import from `@/features`.
 *  3. All cross-folder imports are absolute (`@/...`). A relative import may
 *     not climb (`../`), so moving a file never silently rewires another.
 *
 * Plus one content check: every locale file has the same key set in every
 * language, and no key is defined twice.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../src/", import.meta.url).pathname;
const errors = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !relative(ROOT, f).startsWith("devtools"));
const IMPORT = /(?:from\s+|import\s*\(\s*|^import\s+)["']([^"']+)["']/gm;

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const feature = rel.match(/^features\/([^/]+)\//)?.[1] ?? null;
  const shared = /^(components|lib|providers|i18n)\//.test(rel);
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1];
    if (spec.startsWith("../")) {
      errors.push(`${rel}: relative import climbs out of its folder: "${spec}" — use "@/…"`);
    }
    const deep = spec.match(/^@\/features\/([^/]+)\/(.+)$/);
    if (deep && deep[1] !== feature) {
      errors.push(`${rel}: reaches into feature "${deep[1]}" internals: "${spec}" — import "@/features/${deep[1]}"`);
    }
    if (shared && spec.startsWith("@/features")) {
      errors.push(`${rel}: shared layer depends on a feature: "${spec}"`);
    }
  }
}

// Every feature has a public surface.
const featuresDir = join(ROOT, "features");
for (const name of readdirSync(featuresDir)) {
  const index = join(featuresDir, name, "index.ts");
  try {
    statSync(index);
  } catch {
    errors.push(`features/${name}: missing index.ts (its public surface)`);
  }
}

// Locales agree with each other and never define a key twice.
const localesDir = join(ROOT, "i18n", "locales");
const langs = readdirSync(localesDir);
const keysOf = (file) =>
  [...readFileSync(file, "utf8").matchAll(/^\s{2}([A-Za-z0-9_]+):\s/gm)].map((m) => m[1]);
const perLang = {};
for (const lang of langs) {
  const seen = new Map();
  for (const name of readdirSync(join(localesDir, lang))) {
    if (name === "index.ts") continue;
    for (const key of keysOf(join(localesDir, lang, name))) {
      if (seen.has(key)) errors.push(`i18n/${lang}: key "${key}" defined in both ${seen.get(key)} and ${name}`);
      seen.set(key, name);
    }
  }
  perLang[lang] = seen;
}
const [base, ...others] = langs;
for (const lang of others) {
  for (const [key, file] of perLang[base]) {
    const where = perLang[lang].get(key);
    if (where && where !== file) errors.push(`i18n: "${key}" is in ${base}/${file} but ${lang}/${where}`);
  }
  for (const key of perLang[lang].keys()) {
    if (!perLang[base].has(key)) errors.push(`i18n/${lang}: "${key}" has no ${base} counterpart`);
  }
}

if (errors.length) {
  console.error(`structure check: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log(`structure check: ${files.length} files, ${langs.length} locales, ok`);
