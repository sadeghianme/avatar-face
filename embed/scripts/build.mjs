// The three bundles `npm run build` ships, as the esbuild CLI made them
// (bundled, IIFE, minified), and liveface.js with the engine's private
// members renamed to short names: esbuild keeps every property name as
// written, and the engine's members are most of the bytes its split into
// modules cost. The names are in mangle-props.json; bundle-mangle.test.ts
// holds each to never being read under its own name by another bundle, a
// page, the browser or the network's data.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { names } = JSON.parse(readFileSync(new URL("mangle-props.json", import.meta.url), "utf8"));

const bundle = (entry, outfile, extra = {}) =>
  build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "iife",
    minify: true,
    logLevel: "info",
    ...extra,
  });

await bundle("src/widget.ts", "dist/liveface.js", { mangleProps: new RegExp(`^(${names.join("|")})$`) });
await bundle("src/widget3d.ts", "dist/liveface-3d.js");
await bundle("src/widget-mouth.ts", "dist/liveface-mouth.js");
