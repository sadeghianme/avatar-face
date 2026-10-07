/**
 * The head turning in depth, inside the face mesh (EngineOptions.headMotion
 * "3d", a prototype): every landmark is given a depth, rotated about a pivot
 * between the ears by the head's yaw, pitch and roll, and projected back
 * through a mild perspective. What the rigid layer transform already moves
 * (render2d.ts applyHeadTransform) is taken out, so the two add up to the
 * turn, and the mesh's displacement fades to nothing at its exposed outer
 * edge (the forehead, the temples, the neck band's bottom): the warp stays
 * continuous with the still picture around it, as every other deformation
 * of this mesh does.
 *
 * Depth: the rig keeps only x and y (backend rig.py), so each landmark's
 * depth is MediaPipe's canonical face model (canonical-face.ts) fitted to
 * the photo's own landmarks: a weak-perspective camera (an affine map of
 * the model's x, y, z onto the photo's x, y, least squares over all 468)
 * whose third row, the cross product of the first two at their mean scale,
 * gives each landmark's depth in canvas px. A face photographed turned
 * gets the depth of its own turn.
 */
import { CANONICAL_FACE_CM100 } from "./canonical-face";
import type { FaceMesh, Point } from "./geometry";
import { EYE_CORNERS, IRISES, LEFT_BROW, LOWER_LIDS, RIGHT_BROW, UPPER_LIDS } from "./landmarks";

/** The head's rotation, radians: yaw + turns the nose to the canvas's
 *  right, pitch + nods it down, roll + tilts the crown clockwise. */
export interface HeadPose3D {
  yaw: number;
  pitch: number;
  roll: number;
}

/** The rigid part of the head's motion, as render2d.ts applies it: a shift
 *  and a roll about (pivotX, pivotY), canvas px and radians. */
export interface RigidHead {
  dx: number;
  dy: number;
  roll: number;
  pivotX: number;
  pivotY: number;
}

/** Where the head turns about, in the canonical model's cm: between the
 *  ears (their tragus is at z -2.4), a little below and behind them. */
const PIVOT_CM = { x: 0, y: -0.5, z: -4.2 };
/** A point of the skull the rigid layer is moved with (layered heads): the
 *  head's outline, at the ears' depth and the brow's height. */
const SKULL_CM = { x: 0, y: 2.5, z: -0.5 };
/** The camera's distance from the pivot, in inter-ocular distances: about
 *  60 cm for a 6.3 cm adult IOD, a portrait lens. */
const CAMERA_IOD = 9;
/** Canonical outer eye corners' distance, cm (33 to 263). */
const CANON_IOD = 8.89;
/** Band over which the displacement fades to nothing toward the exposed
 *  hull, in IODs. */
const FADE_IOD = 0.42;
/** The same at the jaw line, which the neck band hangs from. */
const JAW_FADE_IOD = 0.3;
/** A triangle whose area falls below this share of its rest area (or
 *  flips) is folding: its corners are pulled back toward where the face
 *  without the turn put them. */
const MIN_AREA_RATIO = 0.2;
/** How far a raised brow rises at 1, in IODs. */
const BROW_RISE_IOD = 0.05;
/** Passes of neighbour averaging over the depth: the nose's steep sides
 *  turned at full relief slide over the cheek beside them, which a 2D
 *  mesh can only show as a fold. Smoothed, the relief is kept at the
 *  scale of the face and softened at the scale of a triangle. */
const DEPTH_SMOOTHING = 6;

export interface TurnStats {
  /** Triangles folded or crushed before the clamp, and after it. */
  flipsBefore: number;
  flipsAfter: number;
  /** The smallest area ratio after the clamp (1 = unchanged). */
  minAreaRatio: number;
  /** The largest in-mesh displacement this frame, px. */
  maxShift: number;
  /** The share of the turn kept to fold nothing (1: all of it). */
  scale: number;
}

export class HeadTurn {
  /** Per landmark: depth (canvas px, + toward the camera) and how much of
   *  the turn it takes (0 on the exposed hull .. 1 inside the face). */
  readonly depth: Float64Array;
  readonly weight: Float64Array;
  /** The pivot in canvas px; its depth on the same scale. */
  readonly pivot: { x: number; y: number; z: number };
  /** The skull point (SKULL_CM), canvas px. */
  readonly skull: { x: number; y: number; z: number };
  readonly iod: number;
  private readonly camera: number;
  /** The rig's own triangles (landmark indices), for the fold check. */
  private readonly tris: [number, number, number][];
  private readonly restArea: Float64Array;
  /** Brow lift per landmark, px at brow = 1. */
  private readonly browLift: Float64Array;
  readonly stats: TurnStats = { flipsBefore: 0, flipsAfter: 0, minAreaRatio: 1, maxShift: 0, scale: 1 };
  /** Triangles smaller than this (twice their area, px²) are slivers with
   *  no shape to keep: the Delaunay hull's, the eye's corners. */
  private readonly minArea: number;
  /** Scratch buffers, one frame's worth. */
  private readonly before: Float64Array;
  private readonly target: Float64Array;
  private readonly share: Float64Array;

  private constructor(mesh: FaceMesh, rigTriangles: readonly (readonly [number, number, number])[]) {
    const base = mesh.basePoints;
    const n = base.length;
    const fit = fitCanonical(base);
    this.iod = fit.iod;
    this.camera = CAMERA_IOD * fit.iod;
    this.minArea = 0.0005 * fit.iod * fit.iod;
    this.pivot = fit.at(PIVOT_CM);
    this.skull = fit.at(SKULL_CM);
    this.tris = rigTriangles.filter(([a, b, c]) => a < n && b < n && c < n).map(([a, b, c]) => [a, b, c]);
    this.depth = smoothDepth(fit.depth, this.tris, DEPTH_SMOOTHING);
    this.restArea = new Float64Array(this.tris.length);
    this.tris.forEach(([a, b, c], k) => (this.restArea[k] = area(base[a], base[b], base[c])));
    this.weight = hullFade(mesh, this.tris, FADE_IOD * fit.iod, JAW_FADE_IOD * fit.iod);
    this.browLift = browLift(base, fit.iod);
    this.before = new Float64Array(n * 2);
    this.target = new Float64Array(n * 2);
    this.share = new Float64Array(n);
  }

  /** Null for a face too small or too few landmarks to fit. */
  static build(mesh: FaceMesh, rigTriangles: readonly (readonly [number, number, number])[]): HeadTurn | null {
    if (mesh.basePoints.length < 468) return null;
    const t = new HeadTurn(mesh, rigTriangles);
    return t.iod > 4 ? t : null;
  }

  /**
   * Where the turn `pose` takes the skull point (SKULL_CM) on the canvas,
   * less where it rests: the rigid layer's share of the turn.
   */
  skullShift(pose: HeadPose3D): Point {
    const p = this.project(this.skull.x, this.skull.y, this.skull.z, pose);
    return { x: p.x - this.skull.x, y: p.y - this.skull.y };
  }

  /**
   * Turn the face's landmarks in `pts` (canvas px, the frame's deformation
   * so far: the mouth, the lids) by `pose`, inside the head frame `rigid`
   * already moves them through, and raise the brows by `brow` (0..1).
   * Landmarks only: the derived vertices follow them afterwards.
   */
  apply(pts: Point[], pose: HeadPose3D, rigid: RigidHead | null, brow: number): void {
    const n = this.depth.length;
    const { before, target, share, weight } = this;
    const cr = Math.cos(-(rigid?.roll ?? 0)),
      sr = Math.sin(-(rigid?.roll ?? 0));
    let maxShift = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      before[2 * i] = p.x;
      before[2 * i + 1] = p.y;
      const w = weight[i];
      share[i] = w;
      let tx = p.x,
        ty = p.y;
      if (w > 0) {
        const q = this.project(p.x, p.y, this.depth[i], pose);
        tx = q.x;
        ty = q.y;
        if (rigid) {
          // Into the head's frame: undo the rigid shift and roll the layer
          // is drawn through, so layer and mesh add up to the turn.
          const ux = tx - rigid.pivotX - rigid.dx,
            uy = ty - rigid.pivotY - rigid.dy;
          tx = rigid.pivotX + ux * cr - uy * sr;
          ty = rigid.pivotY + ux * sr + uy * cr;
        }
      }
      target[2 * i] = tx - p.x;
      target[2 * i + 1] = ty - p.y;
    }
    // Displace by each landmark's share. A 2D mesh cannot show one part of
    // the face passing in front of another, so a turn that would fold a
    // triangle (the nose's side over the far cheek) is scaled back, whole,
    // to the largest share that folds none (bisection).
    const place = (alpha: number) => {
      for (let i = 0; i < n; i++) {
        pts[i].x = before[2 * i] + target[2 * i] * share[i] * alpha;
        pts[i].y = before[2 * i + 1] + (target[2 * i + 1] * share[i] - brow * this.browLift[i] * weight[i]) * alpha;
      }
    };
    place(1);
    let folded = this.folds(pts);
    this.stats.flipsBefore = folded;
    this.stats.scale = 1;
    if (folded > 0) {
      let lo = 0,
        hi = 1;
      for (let it = 0; it < 7; it++) {
        const mid = (lo + hi) / 2;
        place(mid);
        if (this.folds(pts) > 0) hi = mid;
        else lo = mid;
      }
      place(lo);
      this.stats.scale = lo;
      folded = this.folds(pts);
    }
    this.stats.flipsAfter = folded;
    for (let i = 0; i < n; i++)
      maxShift = Math.max(maxShift, Math.hypot(pts[i].x - before[2 * i], pts[i].y - before[2 * i + 1]));
    this.stats.maxShift = maxShift;
  }

  /** Triangles the turn folded or crushed (below MIN_AREA_RATIO of their
   *  area before it), of those with a shape to keep; records the smallest
   *  ratio. */
  private folds(pts: readonly Point[]): number {
    const { before } = this;
    let count = 0,
      minRatio = Infinity;
    for (let k = 0; k < this.tris.length; k++) {
      const [a, b, c] = this.tris[k];
      const was =
        (before[2 * b] - before[2 * a]) * (before[2 * c + 1] - before[2 * a + 1]) -
        (before[2 * c] - before[2 * a]) * (before[2 * b + 1] - before[2 * a + 1]);
      if (Math.abs(was) < this.minArea || Math.abs(this.restArea[k]) < this.minArea) continue;
      const ratio = area(pts[a], pts[b], pts[c]) / was;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio < MIN_AREA_RATIO) count++;
    }
    this.stats.minAreaRatio = minRatio === Infinity ? 1 : minRatio;
    return count;
  }

  /** (x, y) on the canvas at depth z, turned by `pose` about the pivot and
   *  seen again through the camera. */
  private project(x: number, y: number, z: number, pose: HeadPose3D): Point {
    const P = this.pivot,
      D = this.camera;
    // Back out of the perspective the photo was taken through.
    const Z = z - P.z;
    const k0 = (D - Z) / D;
    let X = (x - P.x) * k0,
      Y = (y - P.y) * k0,
      W = Z;
    // Yaw about the vertical, pitch about the horizontal, roll in the
    // picture plane (y is down, z toward the camera).
    const cy = Math.cos(pose.yaw),
      sy = Math.sin(pose.yaw);
    let t = X * cy + W * sy;
    W = -X * sy + W * cy;
    X = t;
    const cp = Math.cos(pose.pitch),
      sp = Math.sin(pose.pitch);
    t = Y * cp + W * sp;
    W = -Y * sp + W * cp;
    Y = t;
    const cr = Math.cos(pose.roll),
      sr = Math.sin(pose.roll);
    t = X * cr - Y * sr;
    Y = X * sr + Y * cr;
    X = t;
    const k = D / (D - W);
    return { x: P.x + X * k, y: P.y + Y * k };
  }
}

/** Twice the signed area of a triangle. */
function area(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * The canonical model fitted to the photo's landmarks: the depth of every
 * landmark (iris centres and rims from their eye's), the inter-ocular
 * distance, and any model point placed on the canvas.
 */
function fitCanonical(base: readonly Point[]): {
  depth: Float64Array;
  iod: number;
  at: (p: { x: number; y: number; z: number }) => { x: number; y: number; z: number };
} {
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
    iod: CANON_IOD * s,
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

/**
 * Each landmark's share of the turn: 0 on the face mesh's outer edge (the
 * rig's own triangles' boundary: the hairline, the temples by the ears, the
 * jaw line), rising smoothly to 1 at `fade` px inside it, and over a
 * narrower band at the jaw (`jawFade`), whose edge the neck band hangs from:
 * a jaw turned with the face drags the band, and the collar under it, along.
 */
function hullFade(
  mesh: FaceMesh,
  tris: readonly [number, number, number][],
  fade: number,
  jawFade: number
): Float64Array {
  const base = mesh.basePoints;
  const n = base.length;
  const count = new Map<string, [number, number, number]>();
  for (const [a, b, c] of tris) {
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      const e = count.get(key);
      if (e) e[2]++;
      else count.set(key, [i, j, 1]);
    }
  }
  // Below the mouth's corners is the jaw.
  const mouthY = (base[61].y + base[291].y) / 2;
  const edges: { a: Point; b: Point; fade: number }[] = [];
  for (const [i, j, k] of count.values()) {
    if (k !== 1) continue;
    const jaw = base[i].y > mouthY && base[j].y > mouthY;
    edges.push({ a: base[i], b: base[j], fade: jaw ? jawFade : fade });
  }
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = Infinity;
    for (const e of edges) t = Math.min(t, segmentDistance(base[i], e.a, e.b) / e.fade);
    t = Math.max(0, Math.min(1, t));
    w[i] = t * t * (3 - 2 * t);
  }
  return w;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x,
    vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
}

/** How far each landmark rises when the brows go up, px at 1: the brows
 *  and the forehead just above them, nothing at or below the upper lids. */
function browLift(base: readonly Point[], iod: number): Float64Array {
  const lift = new Float64Array(base.length);
  const reach = 0.5 * iod;
  for (let e = 0; e < 2; e++) {
    const brow = e === 0 ? LEFT_BROW : RIGHT_BROW;
    const cx = brow.reduce((s, i) => s + base[i].x, 0) / brow.length;
    const cy = brow.reduce((s, i) => s + base[i].y, 0) / brow.length;
    const lidTop = Math.min(...UPPER_LIDS[e].map((i) => base[i].y));
    for (let i = 0; i < Math.min(468, base.length); i++) {
      const p = base[i];
      if (p.y > lidTop - 0.06 * iod) continue;
      const d = Math.hypot((p.x - cx) * 0.8, p.y - cy) / reach;
      if (d >= 1) continue;
      // Below the brow's own line the lift thins out toward the lid.
      const below = Math.max(0, Math.min(1, (p.y - cy) / Math.max(1, lidTop - cy)));
      const v = (1 - d * d) ** 2 * (1 - below) * BROW_RISE_IOD * iod;
      lift[i] = Math.max(lift[i], v);
    }
  }
  return lift;
}

/** `passes` of Jacobi averaging (half toward the neighbours' mean) over the
 *  triangles' edges. */
function smoothDepth(depth: Float64Array, tris: readonly [number, number, number][], passes: number): Float64Array {
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
