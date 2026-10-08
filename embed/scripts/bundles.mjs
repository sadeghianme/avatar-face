// The bundles `npm run build` ships, as esbuild options: what build.mjs
// writes, and what the browser test builds in memory to draw liveface.js
// with its names renamed and without.

/** Each shipped bundle: its entry point and its file under dist/. */
export const SHIPPED = {
  "liveface.js": "src/widget.ts",
  "liveface-3d.js": "src/widget3d.ts",
  "liveface-mouth.js": "src/widget-mouth.ts",
};

/**
 * The KTX2 texture transcoder liveface-3d.js loads (three's Basis Universal
 * build, which KTX2Loader fetches by these names), copied from the three
 * that is installed, so the version always matches, into dist/ beside the
 * bundle. The API serves it there (backend app.main), so a customer's page
 * fetches it from the API as it does the bundle, never from a CDN.
 */
export const TRANSCODER_DIR = "node_modules/three/examples/jsm/libs/basis";
export const TRANSCODER = ["basis_transcoder.js", "basis_transcoder.wasm"];

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
