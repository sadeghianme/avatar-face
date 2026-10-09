/**
 * The depth the turn in depth (head-turn.ts) gives every landmark. The rig
 * keeps only x and y (backend rig.py), so each landmark's depth is
 * MediaPipe's canonical face model (canonical-face.ts) fitted to the
 * photo's own landmarks: a weak-perspective camera (an affine map of the
 * model's x, y, z onto the photo's x, y, least squares over all 468) whose
 * third row, the cross product of the first two at their mean scale, gives
 * each landmark's depth in canvas px. A face photographed turned gets the
 * depth of its own turn. The same fit places the head's pivot, the skull
 * point its rigid motion follows, and the skull the head's field
 * (head-field.ts) is laid on.
 */
import { CANONICAL_FACE_CM100 } from "./canonical-face";
import type { Point } from "./geometry";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "./landmarks";

/** Where the head turns about, in the canonical model's cm: between the
 *  ears (their tragus is at z -2.4), a little below and behind them. */
export const PIVOT_CM = { x: 0, y: -0.5, z: -4.2 };
/** A point of the skull the rigid motion follows: the head's outline, at
 *  the ears' depth and the brow's height. */
export const SKULL_CM = { x: 0, y: 2.5, z: -0.5 };
/** The skull's centre (head-field.ts): behind the brow, at the pivot's
 *  depth. The head's silhouette lies at its depth. */
export const SKULL_CENTRE_CM = { x: 0, y: 2.5, z: -4.3 };
/** Canonical outer eye corners' distance, cm (33 to 263). */
export const CANON_IOD_CM = 8.89;
/** Passes of neighbour averaging over the depth: the nose's steep sides
 *  turned at full relief slide over the cheek beside them, which a 2D
 *  mesh can only show as a fold. Smoothed, the relief is kept at the
 *  scale of the face and softened at the scale of a triangle. */
const DEPTH_SMOOTHING = 6;

/** The canonical model fitted to a photo's landmarks (fitCanonical). */
export interface CanonicalFit {
  /** Per landmark, its depth, canvas px (+ toward the camera). */
  depth: Float64Array;
  /** The inter-ocular distance, canvas px. */
  iod: number;
  /** A model point (cm) on the canvas, with its depth on the landmarks'
   *  scale. */
  at: (p: { x: number; y: number; z: number }) => { x: number; y: number; z: number };
}

/**
 * The canonical model fitted to the photo's landmarks: the depth of every
 * landmark (iris centres and rims from their eye's), the inter-ocular
 * distance, and any model point placed on the canvas (and given a depth on
 * the landmarks' scale). The head's field (head-field.ts) places the skull
 * with it.
 */
export function fitCanonical(base: readonly Point[]): CanonicalFit {
  const C = CANONICAL_FACE_CM100;
  const m = 468;
  // Normal equations for [x y z 1] -> u and -> v.
  const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const bu = [0, 0, 0, 0],
    bv = [0, 0, 0, 0];
  for (let i = 0; i < m; i++) {
    const r = [C[3 * i] / 100, C[3 * i + 1] / 100, C[3 * i + 2] / 100, 1];
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) A[a][b] += r[a] * r[b];
      bu[a] += r[a] * base[i].x;
      bv[a] += r[a] * base[i].y;
    }
  }
  const ru = solve4(A, bu),
    rv = solve4(A, bv);
  const r1 = [ru[0], ru[1], ru[2]],
    r2 = [rv[0], rv[1], rv[2]];
  const s = (Math.hypot(r1[0], r1[1], r1[2]) + Math.hypot(r2[0], r2[1], r2[2])) / 2;
  let r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const l3 = Math.hypot(r3[0], r3[1], r3[2]) || 1;
  r3 = r3.map((v) => (v / l3) * s);
  // Toward the camera is where the nose tip is, ahead of the ears.
  const zOf = (x: number, y: number, z: number) => r3[0] * x + r3[1] * y + r3[2] * z;
  if (zOf(0, -1.13, 7.48) < zOf(-7.66, 0.67, -2.44)) r3 = r3.map((v) => -v);
  const depth = new Float64Array(base.length);
  for (let i = 0; i < Math.min(m, base.length); i++)
    depth[i] = zOf(C[3 * i] / 100, C[3 * i + 1] / 100, C[3 * i + 2] / 100);
  // The irises: their eye's depth, a little proud of the lids (the cornea).
  for (let e = 0; e < 2; e++) {
    const [c0, c1] = EYE_CORNERS[e];
    const ring = [c0, c1, ...UPPER_LIDS[e], ...LOWER_LIDS[e]];
    const z = ring.reduce((sum, i) => sum + depth[i], 0) / ring.length + 0.25 * s;
    const [centre, rim] = IRISES[e];
    for (const i of [centre, ...rim]) if (i < base.length) depth[i] = z;
  }
  return {
    depth,
    iod: CANON_IOD_CM * s,
    at: (p) => ({
      x: ru[0] * p.x + ru[1] * p.y + ru[2] * p.z + ru[3],
      y: rv[0] * p.x + rv[1] * p.y + rv[2] * p.z + rv[3],
      z: zOf(p.x, p.y, p.z),
    }),
  };
}

/** Gaussian elimination with partial pivoting, 4x4. */
function solve4(A0: number[][], b0: number[]): number[] {
  const A = A0.map((r, i) => [...r, b0[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((r, i) => r[4] / (r[i] || 1e-12));
}

/** `passes` of Jacobi averaging (half toward the neighbours' mean) over the
 *  triangles' edges: the fitted depth, softened at the scale of a
 *  triangle (DEPTH_SMOOTHING). */
export function smoothDepth(
  depth: Float64Array,
  tris: readonly (readonly [number, number, number])[],
  passes = DEPTH_SMOOTHING
): Float64Array {
  const n = depth.length;
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b, c] of tris) {
    nb[a].push(b, c);
    nb[b].push(a, c);
    nb[c].push(a, b);
  }
  let z = Float64Array.from(depth);
  for (let p = 0; p < passes; p++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const list = nb[i];
      if (!list.length) {
        next[i] = z[i];
        continue;
      }
      let sum = 0;
      for (const j of list) sum += z[j];
      next[i] = 0.5 * z[i] + 0.5 * (sum / list.length);
    }
    z = next;
  }
  return z;
}
