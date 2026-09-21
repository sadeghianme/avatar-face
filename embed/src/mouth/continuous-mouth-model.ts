import { ZERO_WEIGHTS, type BlendWeights } from "../types";
import { PERFORMANCE_POSES } from "./photographic-performance-model";
import { REFERENCE_POSES } from "./reference-mouth-model";

const features = (w: BlendWeights) => [w.jawOpen * 1.3, w.mouthPucker * 1.25,
  w.mouthFunnel * .65, w.mouthStretch * .7 + w.mouthSmile * .3, w.mouthClose * .8];
const anchors = PERFORMANCE_POSES.map(id => features(REFERENCE_POSES[id].weights));

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
  const distances = anchors.map(a => a.reduce((sum, v, k) => sum + (v - f[k]) ** 2, 0));
  const exact = distances.findIndex(d => d < 1e-12);
  if (exact >= 0) return distances.map((_, i) => i === exact ? 1 : 0);
  const raw = distances.map(d => 1 / (d * d));
  const sum = raw.reduce((a, b) => a + b, 0);
  const result = raw.map(n => n / sum);
  // Smoothly seal bilabials, even with anticipatory rounding. F/V carries
  // stretch and cannot enter this closure gate.
  const closure = Math.max(0, Math.min(1, (w.mouthClose - .4) / .4)) *
    Math.max(0, Math.min(1, (.2 - w.mouthStretch) / .1));
  const seal = closure * closure * (3 - 2 * closure);
  return result.map((n, i) => n * (1 - seal) + (i === 0 ? seal : 0));
}

/** Exact critically damped integration for a constant target over dt.
 * Velocity is retained across phoneme changes, unlike restarting a tween. */
export function dampMouth(value: number, velocity: number, target: number, dt: number, omega: number): [number, number] {
  const offset = value - target;
  const travel = velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  return [target + (offset + travel * dt) * decay, (velocity - omega * travel * dt) * decay];
}

export class MouthMotion {
  values: number[] = PERFORMANCE_POSES.map((_, i) => i === 0 ? 1 : 0);
  private velocities = PERFORMANCE_POSES.map(() => 0);
  step(w: BlendWeights, dt: number): number[] {
    const target = continuousMouthMix(w);
    const omega = w.mouthClose > .65 && w.mouthStretch < .15 ? 125 : 65;
    this.values = this.values.map((v, i) => {
      const [next, speed] = dampMouth(v, this.velocities[i], target[i], Math.min(.08, Math.max(0, dt)), omega);
      this.velocities[i] = speed;
      return Math.max(0, next);
    });
    const sum = this.values.reduce((a, b) => a + b, 0);
    this.values = this.values.map(v => v / sum);
    return this.values;
  }
}
