/**
 * Where an AI expression picture is laid over the face (docs/emotions.md,
 * "AI expression pictures"): two feathered masks over the picture, read off
 * its own landmarks, as a low-resolution alpha field.
 *
 * - The upper face: the face's oval held in from its outline (so the outline,
 *   the hair and the seams never change, as the animated expressions' rule
 *   is), without the eyes' openings (the gaze and the blink are the
 *   engine's), the lips and a band round them, and everything below the
 *   mouth's middle (the speech moves the lips and the jaw). What is left is
 *   the brows, the forehead, the lids and the eyes' corners, the nose and the
 *   cheeks: what an expression changes and the speech does not.
 * - With `underEye`, the skin under the eyes kept from the source: a
 *   surprise changes the brows and the upper lids, never the cheeks under
 *   the eyes, and a picture's darker, puffier under-eyes there read as
 *   tired, not surprised (the blind judges, 2026-10-11).
 * - The mouth: the lips and a little round them, the opening included. Only
 *   for a picture that smiles with parted lips: the smile shown while the
 *   avatar is silent.
 *
 * Pure: polygons and distances on a grid, so the same field masks the
 * picture (expression-pictures.ts draws it as the picture's alpha) and
 * weighs the mesh's landmarks (the morph under the mask), and the tests
 * read it without a canvas. Feathers are in face widths of the picture.
 */
import type { Point } from "./geometry";
import { EYE_CORNERS, LOWER_LIDS, UPPER_LIDS } from "./landmarks";
import { FACE_OVAL, LOWER_ROWS, UPPER_ROWS } from "./jaw-rig";

/** The grid's cells across the picture's longer side. */
export const MASK_GRID = 128;

/** The oval held in by this much before the mask starts, and over this much it reaches full. */
const OVAL_INSET = 0.04;
const OVAL_FEATHER = 0.08;
/** The lips grown about their middle, and the clear band round them. */
const LIPS_GROWN = 1.3;
const LIPS_FEATHER = 0.12;
/** Below the mouth's middle (down the face): full above this, none by this. */
const BELOW_FROM = -0.04;
const BELOW_TO = 0.04;
/** The eyes' openings, cut with a narrow feather. */
const EYE_FEATHER = 0.012;
/** How far below the eye the source's own under-eye may be kept (pictureMasks `underEye`). */
const UNDER_EYE = 0.12;
/** The smile's mouth: the lips grown, feathered over this. */
const SMILE_GROWN = 1.45;
const SMILE_FEATHER = 0.08;

/** The outer lips, corner to corner over the top and back under. */
const OUTER_LIPS = [61, ...UPPER_ROWS[3], 291, ...[...LOWER_ROWS[3]].reverse()];

/** Each eye's opening: the outer corner, the lower lid, the inner corner, the upper lid back. */
const EYE_RINGS = [0, 1].map((e) => [
  EYE_CORNERS[e][0],
  ...LOWER_LIDS[e],
  EYE_CORNERS[e][1],
  ...[...UPPER_LIDS[e]].reverse(),
]);

export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Distance from `p` to the closed polygon `ring`, signed: negative inside. */
export function signedDistance(p: Point, ring: readonly Point[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return inside ? -best : best;
}

function grown(ring: readonly Point[], by: number): Point[] {
  let cx = 0,
    cy = 0;
  for (const p of ring) {
    cx += p.x;
    cy += p.y;
  }
  cx /= ring.length;
  cy /= ring.length;
  return ring.map((p) => ({ x: cx + (p.x - cx) * by, y: cy + (p.y - cy) * by }));
}

/** An alpha field over a picture: `cols` x `rows` cells of `cell` px. */
export class MaskField {
  constructor(
    readonly cols: number,
    readonly rows: number,
    readonly cell: number,
    readonly alpha: Float32Array
  ) {}

  /** The field at a picture point, bilinear between cell centres. */
  at(p: Point): number {
    const fx = p.x / this.cell - 0.5,
      fy = p.y / this.cell - 0.5;
    const x0 = Math.max(0, Math.min(this.cols - 1, Math.floor(fx))),
      y0 = Math.max(0, Math.min(this.rows - 1, Math.floor(fy)));
    const x1 = Math.min(this.cols - 1, x0 + 1),
      y1 = Math.min(this.rows - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0)),
      ty = Math.min(1, Math.max(0, fy - y0));
    const a = this.alpha;
    const top = a[y0 * this.cols + x0] * (1 - tx) + a[y0 * this.cols + x1] * tx;
    const bottom = a[y1 * this.cols + x0] * (1 - tx) + a[y1 * this.cols + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** Is anything shown at all? */
  get empty(): boolean {
    return !this.alpha.some((v) => v > 0.002);
  }
}

/** The two masks of one picture, from its 478 landmarks `uv` (picture px). */
export interface PictureMasks {
  upper: MaskField;
  /** Null for a picture without a parted-lips smile. */
  mouth: MaskField | null;
}

function field(size: readonly [number, number], value: (p: Point) => number): MaskField {
  const cell = Math.max(size[0], size[1]) / MASK_GRID;
  const cols = Math.max(1, Math.ceil(size[0] / cell)),
    rows = Math.max(1, Math.ceil(size[1] / cell));
  const alpha = new Float32Array(cols * rows);
  const p = { x: 0, y: 0 };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      p.x = (x + 0.5) * cell;
      p.y = (y + 0.5) * cell;
      alpha[y * cols + x] = value(p);
    }
  }
  return new MaskField(cols, rows, cell, alpha);
}

/** The picture's masks (see the module docstring). */
export function pictureMasks(
  uv: readonly Point[],
  size: readonly [number, number],
  smile: boolean,
  underEye = 0
): PictureMasks {
  const face = Math.hypot(uv[454].x - uv[234].x, uv[454].y - uv[234].y) || 1;
  const oval = FACE_OVAL.map((i) => uv[i]);
  const lips = OUTER_LIPS.map((i) => uv[i]);
  const lipsGrown = grown(lips, LIPS_GROWN);
  const smileLips = grown(lips, SMILE_GROWN);
  const eyes = EYE_RINGS.map((ring) => ring.map((i) => uv[i]));
  // Down the face: across the eyes' line, from the mouth's middle.
  const ex = uv[263].x - uv[33].x,
    ey = uv[263].y - uv[33].y;
  const el = Math.hypot(ex, ey) || 1;
  const down = { x: -ey / el, y: ex / el };
  const mouth = { x: (uv[13].x + uv[14].x) / 2, y: (uv[13].y + uv[14].y) / 2 };

  const upper = field(size, (p) => {
    const inOval = smoothstep((-signedDistance(p, oval) / face - OVAL_INSET) / OVAL_FEATHER);
    if (inOval <= 0) return 0;
    const offLips = smoothstep(signedDistance(p, lipsGrown) / face / LIPS_FEATHER);
    const below = ((p.x - mouth.x) * down.x + (p.y - mouth.y) * down.y) / face;
    const above = 1 - smoothstep((below - BELOW_FROM) / (BELOW_TO - BELOW_FROM));
    let open = 1;
    let kept = 0;
    for (const eye of eyes) {
      const d = signedDistance(p, eye) / face;
      open = Math.min(open, smoothstep(d / EYE_FEATHER));
      // Below the eye, the source's own under-eye (`underEye` of it).
      if (underEye > 0 && (p.x - eye[0].x) * down.x + (p.y - eye[0].y) * down.y > 0)
        kept = Math.max(kept, underEye * (1 - smoothstep(d / UNDER_EYE)));
    }
    return inOval * offLips * above * open * (1 - kept);
  });
  const mouthField = smile
    ? field(size, (p) => 1 - smoothstep(signedDistance(p, smileLips) / face / SMILE_FEATHER))
    : null;
  return { upper, mouth: mouthField };
}
