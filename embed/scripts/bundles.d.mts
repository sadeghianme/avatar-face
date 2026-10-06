// Types for bundles.mjs, which build.mjs runs as plain Node and the
// browser test imports.
import type { BuildOptions } from "esbuild";

export const SHIPPED: Record<"liveface.js" | "liveface-3d.js" | "liveface-mouth.js", string>;
export function bundleOptions(root: string, bundle: keyof typeof SHIPPED, names?: string[]): BuildOptions;
