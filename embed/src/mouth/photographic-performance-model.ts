import type { BlendWeights } from "../types";
import { PROFILE_LIMITS, REFERENCE_POSES } from "./reference-mouth-model";

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

/** Where a per-avatar pose came from: the confirmed portrait itself, the
 * person's own AI-made photo of the shape (registered onto the portrait),
 * or the Reference's shape retargeted to this face by the backend. */
export type PoseProvenance = "base" | "generated" | "retargeted";
export interface AvatarPerformanceKeyframe {
  id: PerformancePose;
  /** Pose photos are not delivered: the continuous mouth warps one portrait. */
  image: string | null;
  /** The pose's landmarks in its own photo (fractions of it); null when retargeted. */
  source: XY[] | null;
  points: XY[];
  /** Null for a retargeted pose, which was never registered. */
  registration_rms: number | null;
  provenance: PoseProvenance;
}
/**
 * One avatar's own performance manifest, version 2, built by the backend
 * (app/services/performance_kit.py). The fields ContinuousMouth reads keep
 * the Reference's meaning. Retargeted poses are baked by the backend, so
 * the engine treats every pose alike; the falloff away from the mouth
 * (performanceInfluence) is computed on `poses[0]`, which here is this
 * face's own neutral points.
 */
export interface AvatarPerformanceManifest {
  version: 2;
  /** "avatar-v1:<kit id>". */
  character: string;
  poses: AvatarPerformanceKeyframe[];
  triangles: [number, number, number][];
  center: XY;
  mouth_width: number;
  inner_ring: number[];
  outer_ring: number[];
  /** The profile jawRange this geometry is true at: movement = jawRange / jaw_range. */
  jaw_range: number;
  frame?: { image_size: [number, number]; to_manifest: [number, number, number][] };
  kit?: { version: number; prompts: string; reference: string };
}
/** What ContinuousMouth plays: the bundled Reference motion or an avatar's own. */
export type MotionManifest = PerformanceManifest | AvatarPerformanceManifest;

export const AVATAR_CHARACTER = /^avatar-v1:[A-Za-z0-9_-]{1,64}$/;
const PROVENANCE: Record<PoseProvenance, true> = { base: true, generated: true, retargeted: true };

/**
 * The continuous mouth's loader check: version 1 exactly as
 * validatePerformanceManifest has always checked it (the lab's crossfade
 * player keeps calling that one, and never accepts an avatar manifest,
 * whose pose photos do not exist), or a version 2 avatar manifest.
 */
export function validateMotionManifest(value: unknown): MotionManifest {
  const m = value as AvatarPerformanceManifest | null;
  if (!m || (m as { version?: unknown }).version !== 2) return validatePerformanceManifest(value);
  const finitePoint = (p: unknown): p is XY => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 3);
  const [jawLow, jawHigh] = PROFILE_LIMITS.jawRange;
  if (typeof m.character !== "string" || !AVATAR_CHARACTER.test(m.character) ||
      !Array.isArray(m.poses) || m.poses.length !== PERFORMANCE_POSES.length ||
      !finitePoint(m.center) || !Number.isFinite(m.mouth_width) || m.mouth_width < .03 || m.mouth_width > .6 ||
      typeof m.jaw_range !== "number" || !Number.isFinite(m.jaw_range) || m.jaw_range < jawLow || m.jaw_range > jawHigh ||
      !Array.isArray(m.triangles) || m.triangles.length > 2000) throw new Error("Invalid avatar motion manifest");
  for (let i = 0; i < m.poses.length; i++) {
    const p = m.poses[i];
    const rms = p.registration_rms;
    // The rest pose is the portrait; only a generated pose was registered.
    const provenanceOk = PROVENANCE[p.provenance] === true && (i === 0) === (p.provenance === "base");
    const rmsOk = p.provenance === "retargeted" ? rms === null
      : typeof rms === "number" && Number.isFinite(rms) && rms >= 0 && rms <= .007;
    if (p.id !== PERFORMANCE_POSES[i] || !provenanceOk || !rmsOk ||
        !(p.image === null || (typeof p.image === "string" && /^[a-z0-9-]+\.(png|webp)$/.test(p.image))) ||
        !(p.source === null || (Array.isArray(p.source) && p.source.length === 478 && p.source.every(finitePoint))) ||
        !Array.isArray(p.points) || p.points.length !== 478 || !p.points.every(finitePoint)) throw new Error("Invalid avatar pose");
  }
  const validIndex = (n: number) => Number.isInteger(n) && n >= 0 && n < 478;
  if (!m.triangles.length || !m.triangles.every(t => Array.isArray(t) && t.length === 3 && t.every(validIndex) && new Set(t).size === 3) ||
      ![m.inner_ring, m.outer_ring].every(r => Array.isArray(r) && r.length >= 8 && r.length <= 40 && r.every(validIndex) && new Set(r).size === r.length)) throw new Error("Invalid avatar motion mesh");
  return m;
}
