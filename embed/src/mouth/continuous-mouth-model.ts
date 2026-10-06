import { ZERO_WEIGHTS, type BlendWeights } from "../types";
import { PERFORMANCE_POSES } from "./photographic-performance-model";
import { REFERENCE_POSES } from "./reference-mouth-model";

const features = (w: BlendWeights) => [
  w.jawOpen * 1.3,
  w.mouthPucker * 1.25,
  w.mouthFunnel * 0.65,
  w.mouthStretch * 0.7 + w.mouthSmile * 0.3,
  w.mouthClose * 0.8,
];
const anchors = PERFORMANCE_POSES.map((id) => features(REFERENCE_POSES[id].weights));

/** Rendering must use the same spring-integrated pose as the lip geometry,
 * not the input target (which may already be on the next phoneme). */
export function mouthMixWeights(mix: readonly number[]): BlendWeights {
  const weights = { ...ZERO_WEIGHTS };
  for (const key of Object.keys(weights) as (keyof BlendWeights)[]) {
    weights[key] = PERFORMANCE_POSES.reduce((sum, id, i) => sum + REFERENCE_POSES[id].weights[key] * (mix[i] ?? 0), 0);
  }
  return weights;
}

/** Continuous interpolation, without the old closest-edge winner switching.
 * These coefficients move geometry only. No expression textures are dissolved. */
export function continuousMouthMix(w: BlendWeights): number[] {
  const f = features(w);
  const distances = anchors.map((a) => a.reduce((sum, v, k) => sum + (v - f[k]) ** 2, 0));
  const exact = distances.findIndex((d) => d < 1e-12);
  if (exact >= 0) return distances.map((_, i) => (i === exact ? 1 : 0));
  const raw = distances.map((d) => 1 / (d * d));
  const sum = raw.reduce((a, b) => a + b, 0);
  const result = raw.map((n) => n / sum);
  const seal = bilabialSeal(w);
  return result.map((n, i) => n * (1 - seal) + (i === 0 ? seal : 0));
}

/** How far the lips are sealed, 0 to 1: smoothly, so bilabials close even
 *  with anticipatory rounding. F/V carries stretch and cannot enter this
 *  closure gate. */
export function bilabialSeal(w: BlendWeights): number {
  const closure =
    Math.max(0, Math.min(1, (w.mouthClose - 0.4) / 0.4)) * Math.max(0, Math.min(1, (0.2 - w.mouthStretch) / 0.1));
  return closure * closure * (3 - 2 * closure);
}

/** Exact critically damped integration for a constant target over dt.
 * Velocity is retained across phoneme changes, unlike restarting a tween. */
export function dampMouth(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  omega: number
): [number, number] {
  const offset = value - target;
  const travel = velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  return [target + (offset + travel * dt) * decay, (velocity - omega * travel * dt) * decay];
}

/**
 * The pose spring's stiffness, 1/s (critically damped: it settles in about
 * 4/omega with no overshoot).
 *
 * The spring follows the engine's already smoothed weights, so what it
 * adds is not lag on the vowels (the engine's lead covers it) but a floor
 * under how fast the mixture of poses may change: with inverse-square
 * mixing, a small move of the weights between two anchors is a large move
 * of the mixture. Measured with the real engine on the production cue
 * track at 60 fps, the stiffness of 65 let the mixture change by more
 * than half its mass in 17 frames of a sentence and the lip gap by 0.081
 * of the mouth's width in one frame; at 35, by 4 frames and 0.063, with
 * the gap's acceleration down a third and the peak opening down 1%.
 */
export const SPRING_OMEGA = 35;
/**
 * The stiffness toward a bilabial closure: /p/ /b/ /m/ shut within their
 * own 40 to 80 ms, which the resting stiffness cannot. Reached smoothly, by
 * the same seal that gates the mixture: a switch at one threshold (125
 * above mouthClose 0.65, 65 below) gave the spring a new stiffness
 * mid-flight and the lips a jolt at every closure, the largest step of
 * the whole sentence.
 */
export const CLOSURE_OMEGA = 80;

export class MouthMotion {
  values: number[] = PERFORMANCE_POSES.map((_, i) => (i === 0 ? 1 : 0));
  private velocities = PERFORMANCE_POSES.map(() => 0);
  step(w: BlendWeights, dt: number): number[] {
    const target = continuousMouthMix(w);
    const omega = SPRING_OMEGA + (CLOSURE_OMEGA - SPRING_OMEGA) * bilabialSeal(w);
    this.values = this.values.map((v, i) => {
      const [next, speed] = dampMouth(v, this.velocities[i], target[i], Math.min(0.08, Math.max(0, dt)), omega);
      this.velocities[i] = speed;
      return Math.max(0, next);
    });
    const sum = this.values.reduce((a, b) => a + b, 0);
    this.values = this.values.map((v) => v / sum);
    return this.values;
  }
}
