/**
 * What the face is doing this frame: the one piece of state the engine's
 * parts share. The tick writes it (speech.ts the mouth, motion.ts the eyes);
 * the deformation and the painters read it.
 */
import { ZERO_WEIGHTS, type BlendWeights } from "../types";
import { NONE, type ShapeMix } from "./expression-rig";
import type { Point } from "./geometry";

export interface FaceState {
  /** The articulation now: blend weights, smoothed toward `targetWeights`. */
  weights: BlendWeights;
  /** What the articulation is heading for this frame (the cue blend, or
   *  the pose a mouth driver supplies). */
  targetWeights: BlendWeights;
  /** How high the character mouth's tongue is, 0..1, eased toward the
   *  sound being made. */
  tongue: number;
  /** Blink phase, 0 open (blink.ts). */
  blink: number;
  /** Where the eyes look: offsets in eye-widths. */
  gaze: Point;
  /** How much of each expression is on, 0..1 each (expression-mixer.ts):
   *  laid on the face after the mouth and the jaw (expression-rig.ts). */
  expression: ShapeMix;
}

/** A face at rest: mouth closed, eyes open and on the viewer. */
export function restingFace(): FaceState {
  return {
    weights: { ...ZERO_WEIGHTS },
    targetWeights: { ...ZERO_WEIGHTS },
    tongue: 0,
    blink: 0,
    gaze: { x: 0, y: 0 },
    expression: NONE,
  };
}
