// The bundles `npm run build` ships, as esbuild options: what build.mjs
// writes, and what the browser test builds in memory to draw liveface.js
// with its names renamed and without.

/** Each shipped bundle: its entry point and its file under dist/. */
export const SHIPPED = {
  "liveface.js": "src/widget.ts",
  "liveface-3d.js": "src/widget3d.ts",
  "liveface-mouth.js": "src/widget-mouth.ts",
};

/** esbuild's options for `bundle`; `names` are the properties liveface.js
 *  renames (mangle-names.mjs), ignored for the other two. */
export function bundleOptions(root, bundle, names = []) {
  return {
    absWorkingDir: root,
    entryPoints: [SHIPPED[bundle]],
    outfile: `dist/${bundle}`,
    bundle: true,
    format: "iife",
    minify: true,
    ...(bundle === "liveface.js" && names.length ? { mangleProps: new RegExp(`^(${names.join("|")})$`) } : {}),
  };
}
