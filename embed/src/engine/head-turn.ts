/**
 * The head turning in depth, inside the face mesh (EngineOptions.headMotion
 * "3d", the default for a person's photo): every landmark is given a depth
 * (head-depth.ts), turned by the head's yaw and pitch about a pivot between
 * the ears, and projected back through a mild perspective (head-camera.ts).
 * The head's rigid motion (render2d.ts headMotionAffine: the layer, the
 * whole picture or the bust moved as one) carries a share of the turn and
 * all of the roll (apply; head-placement.ts says how much of the turn), and
 * this carries the rest.
 *
 * A frame's turn (HeadTurn.apply), in the head's frame:
 *  - every landmark turned and projected;
 *  - the outline held where the rigid motion puts it, or, with the head's
 *    field (head-field.ts), let go as far as the field's band of hair takes
 *    it (head-field-turn.ts), and only the outline's own travel taken out
 *    of the face, extended smoothly over it (head-outline.ts);
 *  - each eye and the lips moved as one piece, and the brows raised;
 *  - a turn that would fold a triangle eased, or scaled back (head-fold.ts).
 * Then the head's field's own vertices turn on the skull with it
 * (HeadTurn.field).
 *
 * It runs on every frame of the "3d" motion, so it keeps its working
 * arrays from frame to frame.
 */
import { IDENTITY, apply as applyAffine, invert, type Affine } from "./affine";
import type { FaceMesh, Point } from "./geometry";
import { CAMERA_IOD, projectTurn, type HeadPose3D } from "./head-camera";
import { PIVOT_CM, SKULL_CM, fitCanonical, smoothDepth } from "./head-depth";
import type { HeadField } from "./head-field";
import { FieldTurn } from "./head-field-turn";
import { EASE_PASSES, FoldCheck, longer } from "./head-fold";
import { outlineBasis, outlineFade, type OutlineBasis } from "./head-outline";
import { INNER_LOWER, INNER_UPPER, LIP_CORNERS, LOWER_ROWS, UPPER_ROWS } from "./jaw-rig";
import { EYE_CORNERS, IRISES, LEFT_BROW, LOWER_LIDS, RIGHT_BROW, UPPER_LIDS } from "./landmarks";

/** The band over which the brows' raise fades out toward the outline, in
 *  IODs. */
const FADE_IOD = 0.42;
/** The band, in IODs, over which what is left of the turn next to the
 *  outline (the side of the face foreshortening toward its silhouette,
 *  which a real face hides behind itself and a 2D mesh can only crush)
 *  fades out. */
const EDGE_IOD = 0.3;
/** How far a raised brow rises at 1, in IODs. */
const BROW_RISE_IOD = 0.05;

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
  /** The head's field (head-field.ts), when the mesh has one: its
   *  triangles' smallest area ratio, and its largest shift, px. */
  headMinAreaRatio: number;
  headMaxShift: number;
  /** The outline's landmarks whose travel the field's band capped this
   *  frame (head-field-turn.ts HEAD_STRAIN), and the smallest share of it
   *  they kept. */
  headCapped: number;
  headMinShare: number;
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
  /** The skull point (head-depth.ts SKULL_CM), canvas px. */
  readonly skull: { x: number; y: number; z: number };
  readonly iod: number;
  readonly basis: OutlineBasis;
  /** The camera's distance from the pivot, px (head-camera.ts). */
  private readonly camera: number;
  /** The rig's own triangles, checked for folds (head-fold.ts). */
  private readonly fold: FoldCheck;
  /** Brow lift per landmark, px at brow = 1. */
  private readonly browLift: Float64Array;
  /** Each eye's landmarks (corners, lids, iris), and the lips': each moves
   *  as one piece. */
  private readonly pieces: number[][];
  readonly stats: TurnStats = {
    flipsBefore: 0,
    eased: 0,
    flipsAfter: 0,
    minAreaRatio: 1,
    maxShift: 0,
    scale: 1,
    headMinAreaRatio: 1,
    headMaxShift: 0,
    headCapped: 0,
    headMinShare: 1,
  };
  /** The head's field this turn moves with the face (head-field.ts), or
   *  null: the outline is then held. */
  readonly head: HeadField | null;
  /** The field turned with the face (head-field-turn.ts), with `head`. */
  private readonly fieldTurn: FieldTurn | null;
  /** Per outline landmark (basis.outline's order), this frame's share of
   *  its own travel it keeps (0: held). */
  private readonly outlineShare: Float64Array;
  /** Per landmark, 1 for the free ones (basis.free). */
  private readonly isFree: Uint8Array;
  /** This frame's turn, for the field: the rotation, the rigid motion
   *  undone (when there is one), the share of the turn kept; nothing until
   *  the first. */
  private readonly turn: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  private readonly back: Affine = { ...IDENTITY };
  private hasBack = false;
  private alpha = 1;
  private turned = false;
  /** Scratch, one frame's worth: each landmark before the turn, where the
   *  turn wants it, its move; where the camera puts one. */
  private readonly before: Float64Array;
  private readonly want: Float64Array;
  private readonly shiftBy: Float64Array;
  private readonly seen: Point = { x: 0, y: 0 };
  private readonly longest = new Float64Array(2);

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
    // Triangles smaller than this (twice their area, px²) are slivers with
    // no shape to keep: the Delaunay hull's, the eye's corners.
    const minArea = 0.0005 * fit.iod * fit.iod;
    this.pivot = fit.at(PIVOT_CM);
    this.skull = fit.at(SKULL_CM);
    const tris = rigTriangles
      .filter(([a, b, c]) => a < n && b < n && c < n)
      .map(([a, b, c]) => [a, b, c] as [number, number, number]);
    this.depth = smoothDepth(fit.depth, tris);
    this.fold = new FoldCheck(tris, base, n, minArea);
    this.basis = basis ?? outlineBasis(base, tris);
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
    this.isFree = new Uint8Array(n);
    for (const i of this.basis.free) this.isFree[i] = 1;
    this.outlineShare = new Float64Array(this.basis.outline.length);
    this.head = mesh.head ?? null;
    this.fieldTurn = this.head
      ? new FieldTurn(this.head, mesh, fit, this.depth, this.basis.outline, this.pivot, this.camera, minArea)
      : null;
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
    const p = projectTurn(this.seen, this.skull.x, this.skull.y, this.skull.z, pose, this.pivot, this.camera);
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
    const turn = this.turn;
    turn.yaw = pose.yaw;
    turn.pitch = pose.pitch;
    turn.roll = 0;
    const n = this.depth.length;
    const { before, want } = this;
    const move = this.shiftBy;
    const back = rigid ? invert(rigid, this.back) : null;
    const q = this.seen;
    // Where the turn takes each landmark, in the head's frame.
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      before[2 * i] = p.x;
      before[2 * i + 1] = p.y;
      projectTurn(q, p.x, p.y, this.depth[i], turn, this.pivot, this.camera);
      if (back) applyAffine(back, q, q);
      want[2 * i] = q.x - p.x;
      want[2 * i + 1] = q.y - p.y;
      move[2 * i] = 0;
      move[2 * i + 1] = 0;
    }
    // The outline's own travel: held, or as much as the head's field takes.
    const { outline, free, weights } = this.basis;
    const h = outline.length;
    const share = this.outlineShare;
    this.stats.headCapped = 0;
    this.stats.headMinShare = 1;
    if (this.fieldTurn) this.fieldTurn.outline(outline, want, move, share, this.stats);
    else share.fill(0);
    // Less what the outline does not travel, extended smoothly inside:
    // the outline's own move on it, the turn's differences everywhere else.
    for (let r = 0; r < free.length; r++) {
      const i = free[r];
      let cx = 0,
        cy = 0,
        dx = 0,
        dy = 0;
      for (let k = 0; k < h; k++) {
        const w = weights[r * h + k];
        const o = outline[k];
        cx += w * want[2 * o];
        cy += w * want[2 * o + 1];
        if (share[k]) {
          dx += w * want[2 * o] * share[k];
          dy += w * want[2 * o + 1] * share[k];
        }
      }
      move[2 * i] = (want[2 * i] - cx) * this.edge[i] + dx;
      move[2 * i + 1] = (want[2 * i + 1] - cy) * this.edge[i] + dy;
    }
    // Each eye as one piece (the irises are on no edge: they go with it): a
    // stretched eye reads as a glance, not a turn. And the lips as one
    // piece: the mouth the speech shaped keeps its shape, its opening to
    // its width, whatever the turn (a 7 degree yaw foreshortened the near
    // half of the mouth by 2 px, the opening's ratio to the width by 0.0024).
    const isFree = this.isFree;
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
    // A triangle the turn would crush or fold has its corners' moves eased
    // toward their neighbours' (a few passes, only there), and a turn that
    // still folds one is scaled back, whole, to the largest share that
    // folds none (head-fold.ts).
    const fold = this.fold;
    this.place(pts, 1, brow);
    let folded = fold.folds(before, pts, this.stats);
    this.stats.flipsBefore = folded;
    this.stats.eased = 0;
    for (let pass = 0; pass < EASE_PASSES && folded > 0; pass++) {
      fold.ease(move, isFree);
      this.stats.eased++;
      this.place(pts, 1, brow);
      folded = fold.folds(before, pts, this.stats);
    }
    this.stats.scale = 1;
    if (folded > 0) {
      let lo = 0,
        hi = 1;
      for (let it = 0; it < 7; it++) {
        const mid = (lo + hi) / 2;
        this.place(pts, mid, brow);
        if (fold.folds(before, pts, this.stats) > 0) hi = mid;
        else lo = mid;
      }
      this.place(pts, lo, brow);
      this.stats.scale = lo;
      folded = fold.folds(before, pts, this.stats);
    }
    this.stats.flipsAfter = folded;
    const longest = this.longest.fill(0);
    for (let i = 0; i < n; i++) longer(longest, pts[i].x - before[2 * i], pts[i].y - before[2 * i + 1]);
    this.stats.maxShift = longest[0];
    this.hasBack = !!back;
    this.alpha = this.stats.scale;
    this.turned = true;
  }

  /** The landmarks at `alpha` of this frame's moves, the brows raised by
   *  `brow`. */
  private place(pts: Point[], alpha: number, brow: number): void {
    const { before, browLift, weight } = this;
    const move = this.shiftBy;
    for (let i = 0; i < this.depth.length; i++) {
      pts[i].x = before[2 * i] + move[2 * i] * alpha;
      pts[i].y = before[2 * i + 1] + (move[2 * i + 1] - brow * browLift[i] * weight[i]) * alpha;
    }
  }

  /**
   * The head's field's own vertices this frame, turned with the face by the
   * last `apply` (head-field-turn.ts): written into `pts` from the field's
   * first (the mesh's order, after the neck band's), or pushed onto it when
   * it ends there. Without a field, nothing; without a turn this frame
   * (`rest`), where they rest.
   */
  field(pts: Point[], rest = false): void {
    const field = this.fieldTurn;
    if (!field) return;
    const live = !rest && this.turned;
    field.place(pts, live ? this.turn : null, live && this.hasBack ? this.back : null, this.alpha, this.stats);
  }

  /** (x, y) on the canvas at depth z, turned by `pose` about the pivot and
   *  seen again through the camera (head-camera.ts). */
  project(x: number, y: number, z: number, pose: HeadPose3D): Point {
    return projectTurn({ x: 0, y: 0 }, x, y, z, pose, this.pivot, this.camera);
  }
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
