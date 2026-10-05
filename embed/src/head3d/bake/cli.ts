/**
 * node dist/head3d-bake.mjs <rig.json> <out.json>
 *
 * Bundled by `npm run build:head3d-bake` (esbuild, platform node). The
 * backend's head3d.bake runs it for every head it builds.
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { Rig } from "../../types";
import { bakeMorphTargets } from "./bake-morphs";

const [rigPath, outPath] = process.argv.slice(2);
if (!rigPath || !outPath) {
  console.error("usage: head3d-bake <rig.json> <out.json>");
  process.exit(2);
}
const rig = JSON.parse(readFileSync(rigPath, "utf8")) as Rig;
const result = bakeMorphTargets(rig);
writeFileSync(outPath, JSON.stringify(result));
const worst = Object.entries(result.fidelity).sort((a, b) => b[1].max - a[1].max)[0];
console.log(
  `baked ${Object.keys(result.targets).length} targets for ${rig.image_size.join("x")} ` +
  `(profile ${result.profile ?? "classic"}); worst linear error ${worst ? `${worst[0]} ${(worst[1].max * 100).toFixed(2)}% of mouth width` : "n/a"}`
);
