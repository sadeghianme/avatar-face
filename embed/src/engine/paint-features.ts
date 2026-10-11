/**
 * Everything painted over the warped mesh, in the head's frame: the skin
 * cues of the expressions on (expression-shading.ts), the eyes
 * (the gaze, then the painted lids or the lashes, paint-eyes.ts), the
 * mouth (paint-mouth.ts), and the debug mesh when it is asked for
 * (debug.ts).
 */
import { drawDebugMesh } from "./debug";
import type { ExpressionRig } from "./expression-rig";
import { drawGaze, drawLashes, drawPaintedLids, type EyeSource } from "./paint-eyes";
import { paintMouthSurface, type MouthSurface } from "./paint-mouth";

export interface Features extends MouthSurface {
  /** The inner-lip ring the debug mesh marks, or null for no debug mesh
   *  (EngineOptions.debugMesh). */
  debugRing: number[] | null;
  /** The expressions laid on this face (null until one was first on):
   *  its skin cues' painter and whether this face takes them. */
  expressionRig: ExpressionRig | null;
}

export function paintFeatures(f: Features): void {
  const { ctx, pts, face } = f;
  const { texture, mesh, samples } = f.picture;
  const eyes: EyeSource = { texture, texPoints: mesh.texPoints };
  f.expressionRig?.paintCues(ctx, pts, face.expression, f.tuning.expression);
  drawGaze(ctx, pts, eyes, face.gaze);
  if (f.profile.blink === "lid") drawPaintedLids(ctx, pts, eyes, face.blink, f.tuning.blink, samples);
  else drawLashes(ctx, pts, face.blink, samples.lashColour);
  paintMouthSurface(f);
  if (f.debugRing) drawDebugMesh(ctx, pts, mesh.triangles, f.debugRing);
}
