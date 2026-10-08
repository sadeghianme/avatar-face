/**
 * The head turning in depth, inside the face mesh (EngineOptions.headMotion
 * "3d", the default for a person's photo): every landmark is given a depth,
 * turned by the head's yaw and pitch about a pivot between the ears, and
 * projected back through a mild perspective. The head's rigid motion
 * (render2d.ts headMotionAffine: the layer, the whole picture or the bust
 * moved as one) carries a share of the turn and all of the roll (apply),
 * and this carries the rest.
 *
 * The outline. The mesh's outer edge borders pixels that do not turn (the
 * hair, the ears, the background, the rigid layer around it), so it must
 * stay where the rigid motion puts it, and the face inside must meet it
 * without a step. A real turn moves the outline too: at 7 degrees of yaw
 * the forehead's top, well in front of the pivot, travels a tenth of an
 * eye distance, the temples a quarter of that. The prototype faded every
 * landmark's turn to nothing over a band 0.42 eye distances wide, so all
 * of that travel was undone inside the band: the forehead and the temples
 * sheared and stretched at the larger turns. Here only the outline's own
 * travel is taken out, and smoothly: the correction is the harmonic
 * extension of the outline's displacement over the mesh (each interior
 * landmark the weighted mean of its neighbours', the outline's held), so
 * the face keeps every difference of the turn between its parts (the nose
 * sweeping across the cheeks, the far cheek widening, the near one
 * narrowing), and loses only the share of the whole face's travel that
 * the outline could not take, spread over the whole face instead of a
 * band. The rigid motion carries that travel where it can.
 *
 * The jaw line is not outline: the neck band (jaw-rig.ts) hangs below it
 * and is drawn with the mesh, so the chin turns and nods with the face and
 * the band's neck skin takes up the difference down to its still bottom
 * edge. (Held, the jaw squeezed the lower face on every nod.) Only the jaw
 * line's two landmarks below each ear, where the band meets the hair, are
 * outline.
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
import { INNER_LOWER, INNER_UPPER, JAW_ARC, LIP_CORNERS, LOWER_ROWS, UPPER_ROWS } from "./jaw-rig";
import { EYE_CORNERS, IRISES, LEFT_BROW, LOWER_LIDS, RIGHT_BROW, UPPER_LIDS } from "./landmarks";
import { apply as applyAffine, invert, type Affine } from "./warp-gl";

/** The head's rotation, radians: yaw + turns the nose to the canvas's
 *  right, pitch + nods it down, roll + tilts the crown clockwise. */
export interface HeadPose3D {
  yaw: number;
  pitch: number;
  roll: number;
}

/** Where the head turns about, in the canonical model's cm: between the
 *  ears (their tragus is at z -2.4), a little below and behind them. */
export const PIVOT_CM = { x: 0, y: -0.5, z: -4.2 };
/** A point of the skull the rigid motion follows: the head's outline, at
 *  the ears' depth and the brow's height. */
export const SKULL_CM = { x: 0, y: 2.5, z: -0.5 };
/** The camera's distance from the pivot, in inter-ocular distances: about
 *  60 cm for a 6.3 cm adult IOD, a portrait lens. */
const CAMERA_IOD = 9;
/** Canonical outer eye corners' distance, cm (33 to 263). */
const CANON_IOD = 8.89;
/** The band over which the brows' raise fades out toward the outline, in
 *  IODs. */
const FADE_IOD = 0.42;
/** The band, in IODs, over which what is left of the turn next to the
 *  outline (the side of the face foreshortening toward its silhouette,
 *  which a real face hides behind itself and a 2D mesh can only crush)
 *  fades out. */
const EDGE_IOD = 0.3;
/** A triangle whose area falls below this share of its rest area (or
 *  flips) is folding: the turn is scaled back until none does. */
const MIN_AREA_RATIO = 0.2;
/** At most this many passes of easing a crushed triangle's corners. */
const EASE_PASSES = 6;
/** How far a raised brow rises at 1, in IODs. */
const BROW_RISE_IOD = 0.05;
/** Passes of neighbour averaging over the depth: the nose's steep sides
 *  turned at full relief slide over the cheek beside them, which a 2D
 *  mesh can only show as a fold. Smoothed, the relief is kept at the
 *  scale of the face and softened at the scale of a triangle. */
const DEPTH_SMOOTHING = 6;
/** The jaw line from one jaw angle to the other, through the chin: inside
 *  the drawn mesh (the neck band hangs from it), so free to turn. Its two
 *  landmarks below each ear stay outline: the band meets the hair there,
 *  and a jaw point turned against the ear's held one crushed the cheek's
 *  last triangles. */
const FREE_JAW = new Set(JAW_ARC.slice(2, -2));

export interface TurnStats {
  /** Triangles folded or crushed before the clamp, and after it. */
  flipsBefore: number;
  /** Passes of easing the crushed triangles' corners took (0: none were). */
  eased: number;
  flipsAfter: number;
  /** The smallest area ratio after the clamp (1 = unchanged). */
  minAreaRatio: number;
  /** The largest in-mesh displacement this frame, px. */
  maxShift: number;
  /** The share of the turn kept to fold nothing (1: all of it). */
  scale: number;
}

/**
 * The harmonic extension over a mesh's landmarks: per free landmark, its
 * weights over the outline's (they sum to 1), so that a value given on the
 * outline extends inside as smoothly as the mesh allows (the discrete
 * Laplace equation, each edge weighted by its inverse length). Depends on
 * the triangles and on the landmarks only up to a similarity, so one serves
 * every viewport of a rig.
 */
export interface OutlineBasis {
  /** The outline's landmarks. */
  readonly outline: Int32Array;
  /** The free landmarks (on an edge, not outline). */
  readonly free: Int32Array;
  /** free.length x outline.length, row by row. */
  readonly weights: Float64Array;
}

export class HeadTurn {
  /** Per landmark: depth (canvas px, + toward the camera). */
  readonly depth: Float64Array;
  /** Per landmark, 0 on the outline .. 1 a fade's width inside it: how far
   *  the brows' raise reaches. */
  readonly weight: Float64Array;
  /** The same over EDGE_IOD: how much of the turn's remainder a landmark
   *  next to the outline keeps. */
  readonly edge: Float64Array;
  /** The pivot in canvas px; its depth on the same scale. */
  readonly pivot: { x: number; y: number; z: number };
  /** The skull point (SKULL_CM), canvas px. */
  readonly skull: { x: number; y: number; z: number };
  readonly iod: number;
  readonly basis: OutlineBasis;
  private readonly camera: number;
  /** The rig's own triangles (landmark indices), for the fold check. */
  private readonly tris: [number, number, number][];
  private readonly restArea: Float64Array;
  /** Brow lift per landmark, px at brow = 1. */
  private readonly browLift: Float64Array;
  /** Each eye's landmarks (corners, lids, iris), and the lips': each moves
   *  as one piece. */
  private readonly pieces: number[][];
  readonly stats: TurnStats = { flipsBefore: 0, eased: 0, flipsAfter: 0, minAreaRatio: 1, maxShift: 0, scale: 1 };
  /** The triangles (indices into tris) the last fold check found crushed. */
  private readonly crushed: number[] = [];
  /** Triangles smaller than this (twice their area, px²) are slivers with
   *  no shape to keep: the Delaunay hull's, the eye's corners. */
  private readonly minArea: number;
  /** Scratch buffers, one frame's worth. */
  private readonly before: Float64Array;
  private readonly want: Float64Array;
  private readonly shiftBy: Float64Array;

  private constructor(
    mesh: FaceMesh,
    rigTriangles: readonly (readonly [number, number, number])[],
    basis: OutlineBasis | null
  ) {
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
    this.basis = basis ?? outlineBasis(base, this.tris);
    this.weight = outlineFade(base, this.basis.outline, FADE_IOD * fit.iod);
    this.edge = outlineFade(base, this.basis.outline, EDGE_IOD * fit.iod);
    const eyes = [0, 1].map((e) => {
      const [c0, c1] = EYE_CORNERS[e];
      const [centre, rim] = IRISES[e];
      return [c0, c1, ...UPPER_LIDS[e], ...LOWER_LIDS[e], centre, ...rim].filter((i) => i < n);
    });
    const lips = [
      ...new Set([...UPPER_ROWS.flat(), ...LOWER_ROWS.flat(), ...LIP_CORNERS, ...INNER_UPPER, ...INNER_LOWER]),
    ];
    this.pieces = [...eyes, lips.filter((i) => i < n)];
    this.browLift = browLift(base, fit.iod);
    this.before = new Float64Array(n * 2);
    this.want = new Float64Array(n * 2);
    this.shiftBy = new Float64Array(n * 2);
  }

  /**
   * Null for a face too small or too few landmarks to fit. `basis`: one
   * built for the same rig (any viewport), else it is built here.
   */
  static build(
    mesh: FaceMesh,
    rigTriangles: readonly (readonly [number, number, number])[],
    basis: OutlineBasis | null = null
  ): HeadTurn | null {
    if (mesh.basePoints.length < 468) return null;
    const t = new HeadTurn(mesh, rigTriangles, basis);
    return t.iod > 4 ? t : null;
  }

  /**
   * Where the turn `pose` takes the skull point (SKULL_CM) on the canvas,
   * less where it rests: the travel the rigid motion takes a share of.
   */
  skullShift(pose: HeadPose3D): Point {
    const p = this.project(this.skull.x, this.skull.y, this.skull.z, pose);
    return { x: p.x - this.skull.x, y: p.y - this.skull.y };
  }

  /**
   * Turn the face's landmarks in `pts` (canvas px, the frame's deformation
   * so far: the mouth, the lids) by the yaw and pitch of `pose`, inside the
   * head's frame: the mesh is drawn through the head's rigid motion
   * relative to the body, whose shift (and a bust's lean) is `rigid` (null
   * for none), so what that already moves is taken out and the two add up
   * to the turn. The outline stays put in that frame. Raise the brows by
   * `brow` (0..1). Landmarks only: the derived vertices and the neck band
   * follow them afterwards.
   *
   * The roll is the rigid motion's alone. A tilt is the whole head turning
   * in the picture's plane, outline and all; inside an outline held still
   * it could only be a shear (the chin swinging under a still brow: 3
   * degrees of it moved the chin 20 px on a 960 px stage), so the rigid
   * motion's own rotation is the tilt the face shows.
   */
  apply(pts: Point[], pose: HeadPose3D, rigid: Affine | null, brow: number): void {
    const turn = { yaw: pose.yaw, pitch: pose.pitch, roll: 0 };
    const n = this.depth.length;
    const { before, want, weight, browLift } = this;
    const move = this.shiftBy;
    const back = rigid ? invert(rigid) : null;
    // Where the turn takes each landmark, in the head's frame.
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      before[2 * i] = p.x;
      before[2 * i + 1] = p.y;
      let q = this.project(p.x, p.y, this.depth[i], turn);
      if (back) q = applyAffine(back, q);
      want[2 * i] = q.x - p.x;
      want[2 * i + 1] = q.y - p.y;
      move[2 * i] = 0;
      move[2 * i + 1] = 0;
    }
    // Less the outline's own travel, extended smoothly inside: nothing on
    // the outline, the turn's differences everywhere else.
    const { outline, free, weights } = this.basis;
    const h = outline.length;
    for (let r = 0; r < free.length; r++) {
      const i = free[r];
      let cx = 0,
        cy = 0;
      for (let k = 0; k < h; k++) {
        const w = weights[r * h + k];
        cx += w * want[2 * outline[k]];
        cy += w * want[2 * outline[k] + 1];
      }
      move[2 * i] = (want[2 * i] - cx) * this.edge[i];
      move[2 * i + 1] = (want[2 * i + 1] - cy) * this.edge[i];
    }
    // Each eye as one piece (the irises are on no edge: they go with it): a
    // stretched eye reads as a glance, not a turn. And the lips as one
    // piece: the mouth the speech shaped keeps its shape, its opening to
    // its width, whatever the turn (a 7 degree yaw foreshortened the near
    // half of the mouth by 2 px, the opening's ratio to the width by 0.0024).
    const isFree = this.freeSet();
    for (const piece of this.pieces) {
      let mx = 0,
        my = 0,
        count = 0;
      for (const i of piece) {
        if (!isFree[i]) continue;
        mx += move[2 * i];
        my += move[2 * i + 1];
        count++;
      }
      if (!count) continue;
      for (const i of piece) {
        move[2 * i] = mx / count;
        move[2 * i + 1] = my / count;
      }
    }
    // A 2D mesh cannot show one part of the face passing in front of
    // another: a triangle the turn would crush or fold (the nose's side
    // against the cheek it passes, the cheek's side toward the silhouette)
    // has its corners' moves eased toward their neighbours' (a few passes,
    // only there), and a turn that still folds one is scaled back, whole,
    // to the largest share that folds none (bisection). At the
    // personality's limits the second never has to happen.
    const place = (alpha: number) => {
      for (let i = 0; i < n; i++) {
        pts[i].x = before[2 * i] + move[2 * i] * alpha;
        pts[i].y = before[2 * i + 1] + (move[2 * i + 1] - brow * browLift[i] * weight[i]) * alpha;
      }
    };
    place(1);
    let folded = this.folds(pts);
    this.stats.flipsBefore = folded;
    this.stats.eased = 0;
    for (let pass = 0; pass < EASE_PASSES && folded > 0; pass++) {
      this.ease(move);
      this.stats.eased++;
      place(1);
      folded = this.folds(pts);
    }
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
    let maxShift = 0;
    for (let i = 0; i < n; i++)
      maxShift = Math.max(maxShift, Math.hypot(pts[i].x - before[2 * i], pts[i].y - before[2 * i + 1]));
    this.stats.maxShift = maxShift;
  }

  private freeMask: Uint8Array | null = null;
  private freeSet(): Uint8Array {
    if (!this.freeMask) {
      this.freeMask = new Uint8Array(this.depth.length);
      for (const i of this.basis.free) this.freeMask[i] = 1;
    }
    return this.freeMask;
  }

  /** Each free corner of the triangles the last fold check found crushed
   *  goes halfway to its triangle's mean move: a pass halves the triangle's
   *  own deformation, and what it gives up its neighbours take. */
  private ease(move: Float64Array): void {
    const isFree = this.freeSet();
    const sum = new Map<number, [number, number, number]>();
    for (const k of this.crushed) {
      const tri = this.tris[k];
      let mx = 0,
        my = 0;
      for (const i of tri) {
        mx += move[2 * i] / 3;
        my += move[2 * i + 1] / 3;
      }
      for (const i of tri) {
        if (!isFree[i]) continue;
        const e = sum.get(i) ?? [0, 0, 0];
        e[0] += mx;
        e[1] += my;
        e[2]++;
        sum.set(i, e);
      }
    }
    for (const [i, [mx, my, count]] of sum) {
      move[2 * i] = 0.5 * move[2 * i] + (0.5 * mx) / count;
      move[2 * i + 1] = 0.5 * move[2 * i + 1] + (0.5 * my) / count;
    }
  }

  /** Triangles the turn folded or crushed (below MIN_AREA_RATIO of their
   *  area before it), of those with a shape to keep; records the smallest
   *  ratio, and which they are. */
  private folds(pts: readonly Point[]): number {
    const { before } = this;
    let count = 0,
      minRatio = Infinity;
    this.crushed.length = 0;
    for (let k = 0; k < this.tris.length; k++) {
      const [a, b, c] = this.tris[k];
      const was =
        (before[2 * b] - before[2 * a]) * (before[2 * c + 1] - before[2 * a + 1]) -
        (before[2 * c] - before[2 * a]) * (before[2 * b + 1] - before[2 * a + 1]);
      if (Math.abs(was) < this.minArea || Math.abs(this.restArea[k]) < this.minArea) continue;
      const ratio = area(pts[a], pts[b], pts[c]) / was;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio < MIN_AREA_RATIO) {
        count++;
        this.crushed.push(k);
      }
    }
    this.stats.minAreaRatio = minRatio === Infinity ? 1 : minRatio;
    return count;
  }

  /** (x, y) on the canvas at depth z, turned by `pose` about the pivot and
   *  seen again through the camera. */
  project(x: number, y: number, z: number, pose: HeadPose3D): Point {
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
 * The outline (the rig's triangles' boundary, less the jaw line the neck
 * band hangs from: its ends below the ears are kept) and the harmonic
 * weights of every other landmark on an edge over it. The Laplacian of the
 * free landmarks is factored once (Cholesky, its envelope after a reverse
 * Cuthill-McKee ordering: a few milliseconds) and solved for each outline
 * landmark's column. Built once per rig (the weights do not change with
 * the viewport).
 */
export function outlineBasis(
  base: readonly Point[],
  tris: readonly (readonly [number, number, number])[]
): OutlineBasis {
  const n = base.length;
  const edgeCount = new Map<number, number>();
  const key = (i: number, j: number) => Math.min(i, j) * 65536 + Math.max(i, j);
  const nb: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (const [a, b, c] of tris) {
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = key(i, j);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      const w = 1 / Math.max(1e-6, Math.hypot(base[i].x - base[j].x, base[i].y - base[j].y));
      nb[i].set(j, w);
      nb[j].set(i, w);
    }
  }
  const onOutline = new Uint8Array(n);
  for (const [k, count] of edgeCount) {
    if (count !== 1) continue;
    const i = Math.floor(k / 65536),
      j = k % 65536;
    if (!FREE_JAW.has(i)) onOutline[i] = 1;
    if (!FREE_JAW.has(j)) onOutline[j] = 1;
  }
  const outline: number[] = [],
    free: number[] = [];
  for (let i = 0; i < n; i++) {
    if (onOutline[i]) outline.push(i);
    else if (nb[i].size) free.push(i);
  }
  const h = outline.length,
    m = free.length;
  // Reverse Cuthill-McKee over the free landmarks: a narrow envelope.
  const isFree = new Uint8Array(n);
  for (const i of free) isFree[i] = 1;
  const degree = (i: number) => {
    let d = 0;
    for (const j of nb[i].keys()) if (isFree[j]) d++;
    return d;
  };
  const order: number[] = [];
  const seen = new Uint8Array(n);
  const byDegree = [...free].sort((a, b) => degree(a) - degree(b));
  for (const start of byDegree) {
    if (seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      order.push(i);
      const next = [...nb[i].keys()].filter((j) => isFree[j] && !seen[j]).sort((a, b) => degree(a) - degree(b));
      for (const j of next) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  order.reverse();
  const pos = new Int32Array(n).fill(-1);
  order.forEach((i, r) => (pos[i] = r));
  // The envelope: row r holds columns first[r] .. r.
  const first = new Int32Array(m);
  const start = new Int32Array(m + 1);
  for (let r = 0; r < m; r++) {
    let f = r;
    for (const j of nb[order[r]].keys()) if (isFree[j]) f = Math.min(f, pos[j]);
    first[r] = f;
    start[r + 1] = start[r] + (r - f + 1);
  }
  const L = new Float64Array(start[m]);
  const at = (r: number, c: number) => start[r] + (c - first[r]);
  for (let r = 0; r < m; r++) {
    const i = order[r];
    let total = 0;
    for (const [j, w] of nb[i]) {
      total += w;
      if (isFree[j] && pos[j] < r) L[at(r, pos[j])] = -w;
    }
    // A free landmark with no path to the outline still solves (to 0).
    L[at(r, r)] = total * (1 + 1e-13) + 1e-300;
  }
  for (let r = 0; r < m; r++) {
    for (let c = first[r]; c <= r; c++) {
      let sum = L[at(r, c)];
      const k0 = Math.max(first[r], first[c]);
      for (let k = k0; k < c; k++) sum -= L[at(r, k)] * L[at(c, k)];
      L[at(r, c)] = c === r ? Math.sqrt(Math.max(sum, 1e-300)) : sum / L[at(c, c)];
    }
  }
  // Each outline landmark's column: its free neighbours' right-hand side.
  const weights = new Float64Array(m * h);
  const x = new Float64Array(m);
  for (let k = 0; k < h; k++) {
    x.fill(0);
    for (const [j, w] of nb[outline[k]]) if (isFree[j]) x[pos[j]] += w;
    for (let r = 0; r < m; r++) {
      let sum = x[r];
      for (let c = first[r]; c < r; c++) sum -= L[at(r, c)] * x[c];
      x[r] = sum / L[at(r, r)];
    }
    for (let r = m - 1; r >= 0; r--) {
      x[r] /= L[at(r, r)];
      for (let c = first[r]; c < r; c++) x[c] -= L[at(r, c)] * x[r];
    }
    for (let r = 0; r < m; r++) weights[r * h + k] = x[r];
  }
  // Rows in `order`: the free landmarks listed in that order.
  return { outline: Int32Array.from(outline), free: Int32Array.from(order), weights };
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

/** 0 on the outline's landmarks, rising smoothly to 1 at `fade` px from
 *  the nearest of them. */
function outlineFade(base: readonly Point[], outline: Int32Array, fade: number): Float64Array {
  const w = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) {
    let d = Infinity;
    for (const j of outline) d = Math.min(d, Math.hypot(base[i].x - base[j].x, base[i].y - base[j].y));
    const t = Math.max(0, Math.min(1, d / fade));
    w[i] = t * t * (3 - 2 * t);
  }
  return w;
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
