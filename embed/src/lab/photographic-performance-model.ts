import type { BlendWeights } from "../types";
import { REFERENCE_POSES } from "./reference-mouth-model";

export type PerformancePose = "rest" | "aa" | "ee" | "oo" | "oh" | "fv" | "th";
export type XY = [number, number];
export interface PerformanceKeyframe {
  id: PerformancePose;
  image: string;
  source: XY[];
  points: XY[];
  registration_rms: number;
}
export interface PerformanceManifest {
  version: number;
  character: string;
  poses: PerformanceKeyframe[];
  triangles: [number, number, number][];
  center: XY;
  mouth_width: number;
  inner_ring: number[];
  outer_ring: number[];
}
export const PERFORMANCE_POSES: PerformancePose[] = ["rest", "aa", "ee", "oo", "oh", "fv", "th"];

const features = (w: BlendWeights): number[] => [
  w.jawOpen * 1.3, w.mouthPucker * 1.25, w.mouthFunnel * .65,
  w.mouthStretch * .7 + w.mouthSmile * .3, w.mouthClose * .8,
];
const anchors = PERFORMANCE_POSES.map(id => features(REFERENCE_POSES[id].weights));
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Project the smoothed articulation onto the closest authored edge. At most
 * two textures contribute; geometry and appearance use the SAME coefficients.
 * This avoids interpolating a wide tooth row into every rounded vowel. */
export function performanceMix(w: BlendWeights): number[] {
  const result = PERFORMANCE_POSES.map(() => 0);
  // Bilabial sealing is categorical anatomy: residual anticipatory rounding
  // must not make P/B/M choose an open OO photograph.
  if (w.mouthClose > .68 && w.mouthStretch < .14 ||
      w.jawOpen < .035 && w.mouthPucker < .12 && w.mouthStretch < .14) {
    result[0] = 1; return result;
  }
  const f = features(w);
  let best = Infinity;
  for (let a = 0; a < anchors.length; a++) for (let b = a; b < anchors.length; b++) {
    const delta = anchors[b].map((v, k) => v - anchors[a][k]);
    const length = delta.reduce((sum, v) => sum + v * v, 0);
    const t = length > 0 ? clamp(delta.reduce((sum, v, k) => sum + v * (f[k] - anchors[a][k]), 0) / length) : 0;
    const error = f.reduce((sum, v, k) => sum + (v - anchors[a][k] - delta[k] * t) ** 2, 0);
    if (error < best) {
      best = error; result.fill(0); result[a] += 1 - t; result[b] += t;
    }
  }
  return result;
}

/** Compact support with zero slope at both boundaries. Identical for geometry
 * and feathering; the rest of the face never receives another pose's texture. */
export function performanceInfluence(x: number, y: number, center: XY, width: number): number {
  const dx = (x - center[0]) / (width * .98);
  const dy = (y - center[1]) / (width * .9);
  const radius = Math.hypot(dx, dy);
  const t = clamp((1 - radius) / .32);
  const belowNose = clamp((y - (center[1] - width * .4)) / (width * .22));
  return t * t * (3 - 2 * t) * belowNose * belowNose * (3 - 2 * belowNose);
}

export function validatePerformanceManifest(value: unknown): PerformanceManifest {
  const m = value as PerformanceManifest;
  const finitePoint = (p: unknown): p is XY => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 3);
  if (!m || m.version !== 1 || m.character !== "lab-reference-v1" ||
      !Array.isArray(m.poses) || m.poses.length !== PERFORMANCE_POSES.length ||
      !finitePoint(m.center) || !Number.isFinite(m.mouth_width) || m.mouth_width < .03 || m.mouth_width > .6 ||
      !Array.isArray(m.triangles) || m.triangles.length > 2000) throw new Error("Invalid photographic character manifest");
  for (let i = 0; i < m.poses.length; i++) {
    const p = m.poses[i];
    if (p.id !== PERFORMANCE_POSES[i] || !/^[a-z0-9-]+\.(png|webp)$/.test(p.image) ||
        p.source?.length !== 478 || p.points?.length !== 478 ||
        !p.source.every(finitePoint) || !p.points.every(finitePoint) ||
        !Number.isFinite(p.registration_rms) || p.registration_rms < 0 || p.registration_rms > .007) throw new Error("Invalid photographic pose");
  }
  const validIndex = (n: number) => Number.isInteger(n) && n >= 0 && n < 478;
  if (!m.triangles.length || !m.triangles.every(t => Array.isArray(t) && t.length === 3 && t.every(validIndex) && new Set(t).size === 3) ||
      ![m.inner_ring, m.outer_ring].every(r => Array.isArray(r) && r.length >= 8 && r.length <= 40 && r.every(validIndex) && new Set(r).size === r.length)) throw new Error("Invalid photographic mesh");
  return m;
}
