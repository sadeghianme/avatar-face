// The three bundles `npm run build` ships (bundles.mjs: bundled, IIFE,
// minified), and liveface.js with the engine's private members renamed to
// short names: esbuild keeps every property name as written, and the
// engine's members are most of the bytes its split into modules cost.
// mangle-names.mjs derives the names with the TypeScript checker (every
// private or protected member whose renaming nothing outside the bundle
// can see); bundle-mangle.test.ts holds the derivation to its rules, and
// browser-tests/bundle.test.ts draws liveface.js renamed and not, pixel
// for pixel.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

import { SHIPPED, bundleOptions } from "./bundles.mjs";
import { mangledNames } from "./mangle-names.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const names = await mangledNames(root);
for (const bundle of Object.keys(SHIPPED)) {
  await build({ ...bundleOptions(root, bundle, names), logLevel: "info" });
}
