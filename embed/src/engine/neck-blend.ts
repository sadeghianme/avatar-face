/**
 * A layered avatar's neck: where the head's motion hands over to the body's.
 *
 * The layered picture (render2d.ts composeLayered) is a still background, a
 * body layer and a head layer, the photo's own pixels each. The head layer
 * is the head, the neck and the top of the collar, its alpha fading out
 * down the neck (sakineh, bita: from just under the chin to 0.8 mouth
 * widths below it) or cut sharp along the collar (mehdi_avatar). It used to
 * move rigidly with the head over the still body, and the face mesh's neck
 * band with it: below the chin the picture was then two positions of the
 * same neck and collar, cross-faded by the head layer's alpha or stepped at
 * its cut, and the band's bottom edge drew the photo's collar a head's
 * shift from the body's own. That is "the collar tear" (mehdi_avatar: 153
 * detector tears on main, a white wedge of collar over the lapel at a
 * turn), in either head motion.
 *
 * Now every part of the picture moves by one rule: a point resting at
 * (x, y) moves by a share s(x, y) of the head's motion relative to the body
 * (and with the body by all of the body's). s is 1 over the head, eases to
 * 0 down the neck, between the chin and the neck band's bottom edge, and is
 * 0 below: a line that is level as far out as the band reaches and rises
 * beyond it toward the shoulders on either side, so a shoulder that comes
 * up beside a short neck stays with the body rather than nodding with the
 * head (bita's did, and showed the background layer's halo along its edge
 * at the largest turns). The head layer and the body layer are drawn through that warp
 * (render2d.ts), the neck band's vertices are placed by it (deform.ts), and
 * both by the same piecewise-affine map (NeckWarp), so they agree to the
 * pixel: the band's bottom edge, the layers' collar and the body below
 * stay where the body puts them, the head and everything up to the chin go
 * with the head, and the neck between stretches, as a neck does. No pixel
 * is drawn in two positions; nothing is left to tear.
 */
import type { FaceMesh, Point, Rect } from "./geometry";
import { apply, invert, type Affine } from "./affine";

/** Rows the eased part of the picture is drawn in (half of them across the
 *  neck), and columns either side of the band, where the line rises toward
 *  the shoulders. */
const ROWS = 8;
const SIDE_COLUMNS = 3;
/** How far the line where the share starts to fall rises per pixel out
 *  beyond the band (on average: eased in and out), toward the shoulders,
 *  and how far it rises at most, in the neck's own heights (chin to band
 *  bottom). Over the band itself it is level: the band's edges are straight
 *  between its vertices, and they meet the layers' warp exactly only where
 *  the warp is affine along them (a line rising under the band stepped a
 *  striped collar by 5 levels). */
const SHOULDER_SLOPE = 0.5;
const SHOULDER_RISE = 1;

/** Where the head's share of the motion falls from 1 to 0, canvas px at
 *  rest: from `top` (the chin) to `bottom` (the band's bottom edge) within
 *  `halfWidth` of `cx` (the band's reach), higher by `slope` per px beyond. */
export interface NeckBlend {
  top: number;
  bottom: number;
  cx: number;
  halfWidth: number;
  slope: number;
}

/** The neck's blend for a mesh with a band; null without one. */
export function neckBlendFor(mesh: FaceMesh): NeckBlend | null {
  const p = mesh.basePoints;
  const chin = p[152];
  if (!chin || !mesh.neckBand.length) return null;
  const bottom = Math.max(...mesh.neckBand.map((v) => v.base.y));
  if (bottom <= chin.y + 1) return null;
  const halfWidth = Math.max(...mesh.neckBand.map((v) => Math.abs(v.base.x - chin.x))) + 1;
  return { top: chin.y, bottom, cx: chin.x, halfWidth, slope: SHOULDER_SLOPE };
}

/** How far beside the neck the line rises before it levels off, px. */
function riseReach(blend: NeckBlend): number {
  return (SHOULDER_RISE * (blend.bottom - blend.top)) / blend.slope;
}

/** Where the share starts to fall at `x`: the chin's height under the
 *  neck, rising beside it (eased in and out, `slope` on average) to a
 *  neck's height higher. */
function fallsFrom(blend: NeckBlend, x: number): number {
  const reach = riseReach(blend);
  const t = Math.min(1, Math.max(0, Math.abs(x - blend.cx) - blend.halfWidth) / reach);
  return blend.top - blend.slope * reach * t * t * (3 - 2 * t);
}

/** The head's share of the motion at rest (x, y): 1 above where it falls,
 *  0 a neck's height below, eased between. */
export function headShare(blend: NeckBlend, x: number, y: number): number {
  const t = Math.max(0, Math.min(1, (y - fallsFrom(blend, x)) / (blend.bottom - blend.top)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The warp as a grid over the picture: a row above where the share starts
 * to fall anywhere (the head's motion, whole), ROWS rows down to the band's
 * bottom, each cut into the neck's own column and SIDE_COLUMNS either side
 * of it, and a row below (the body's). A grid corner moves by its own
 * share; a point between by the affine of the cell's triangle it rests in.
 * Body frame: what the body's own motion (sway, breath) then moves.
 */
export class NeckWarp {
  /** Rest heights of the rows' edges, and rest x of the columns' (the top
   *  and bottom rows are one cell). */
  readonly ys: number[];
  readonly xs: number[];
  /** Each corner's share, row by row. */
  readonly shares: number[][];
  /** Each corner where the head's motion `update` was given puts it, row by
   *  row, body-frame px. */
  private readonly moved: Point[][];

  constructor(
    readonly blend: NeckBlend,
    picture: Rect
  ) {
    const x0 = picture.x - 1,
      x1 = picture.x + picture.w + 1;
    // Columns: the neck's, SIDE_COLUMNS either side where the line rises,
    // and one more out to the picture's edge where it is level again; those
    // the picture does not reach left out.
    const reach = riseReach(blend);
    const edges = [blend.cx - blend.halfWidth - reach];
    for (let i = 0; i <= SIDE_COLUMNS; i++)
      edges.push(blend.cx - blend.halfWidth - (reach * (SIDE_COLUMNS - i)) / SIDE_COLUMNS);
    for (let i = 0; i <= SIDE_COLUMNS; i++) edges.push(blend.cx + blend.halfWidth + (reach * i) / SIDE_COLUMNS);
    this.xs = [x0, ...edges.filter((x) => x > x0 + 0.5 && x < x1 - 0.5), x1].filter(
      (x, i, all) => i === 0 || x > all[i - 1] + 0.5
    );
    const high = blend.top - blend.slope * reach;
    const top = Math.min(picture.y, high) - 1,
      bottom = Math.max(picture.y + picture.h, blend.bottom) + 1;
    this.ys = [top];
    for (let k = 0; k <= ROWS; k++) this.ys.push(high + ((blend.bottom - high) * k) / ROWS);
    this.ys.push(bottom);
    this.shares = this.ys.map((y) => this.xs.map((x) => headShare(blend, x, y)));
    this.moved = this.ys.map((y) => this.xs.map((x) => ({ x, y })));
  }

  /** The head moved by `head` relative to the body (head frame to body
   *  frame): every corner by its share of it. */
  update(head: Affine): void {
    this.ys.forEach((y, j) => {
      this.xs.forEach((x, i) => {
        const s = this.shares[j][i];
        const h = apply(head, { x, y });
        this.moved[j][i] = { x: x + s * (h.x - x), y: y + s * (h.y - y) };
      });
    });
  }

  /** The grid's triangles: rest corners and moved ones, in drawing order
   *  (the top and bottom rows whole, the neck's cell by cell). */
  triangles(): { rest: [Point, Point, Point]; moved: [Point, Point, Point] }[] {
    const out: { rest: [Point, Point, Point]; moved: [Point, Point, Point] }[] = [];
    const last = this.ys.length - 2;
    const columns = this.xs.length - 1;
    for (let j = 0; j <= last; j++) {
      const whole = j === 0 || j === last;
      const step = whole ? columns : 1;
      for (let i = 0; i < columns; i += step) {
        const i1 = i + step;
        const r = (jj: number, ii: number): Point => ({ x: this.xs[ii], y: this.ys[jj] });
        const m = (jj: number, ii: number): Point => this.moved[jj][ii];
        out.push(
          { rest: [r(j, i), r(j, i1), r(j + 1, i1)], moved: [m(j, i), m(j, i1), m(j + 1, i1)] },
          { rest: [r(j, i), r(j + 1, i1), r(j + 1, i)], moved: [m(j, i), m(j + 1, i1), m(j + 1, i)] }
        );
      }
    }
    return out;
  }

  /** Where the warp puts a point resting at `p`, body frame: by the affine
   *  of the grid triangle it rests in (outside the grid, the nearest). */
  at(p: Point): Point {
    const { xs, ys } = this;
    const j = clampIndex(ys, p.y);
    const last = ys.length - 2;
    const whole = j === 0 || j === last;
    let i0 = 0,
      i1 = xs.length - 1;
    if (!whole) {
      i0 = clampIndex(xs, p.x);
      i1 = i0 + 1;
    }
    const x0 = xs[i0],
      x1 = xs[i1],
      y0 = ys[j],
      y1 = ys[j + 1];
    const u = (p.x - x0) / (x1 - x0),
      v = (p.y - y0) / (y1 - y0);
    const m = this.moved;
    // The cell's diagonal runs from (x0, y0) to (x1, y1): above it the
    // first triangle, below it the second.
    const [A, B, C] = u >= v ? [m[j][i0], m[j][i1], m[j + 1][i1]] : [m[j][i0], m[j + 1][i1], m[j + 1][i0]];
    // Barycentric weights in the rest cell (u, v in the unit square).
    const [wa, wb, wc] = u >= v ? [1 - u, u - v, v] : [1 - v, u, v - u];
    return { x: wa * A.x + wb * B.x + wc * C.x, y: wa * A.y + wb * B.y + wc * C.y };
  }
}

function clampIndex(edges: readonly number[], v: number): number {
  let k = 0;
  while (k < edges.length - 2 && v > edges[k + 1]) k++;
  return k;
}

/** The neck band's hold on the body this frame: the warp, and the head's
 *  motion relative to the body undone. */
export interface NeckPin {
  warp: NeckWarp;
  /** The head's motion relative to the body, inverted: the mesh is drawn
   *  through the head's motion, so a point the warp puts at q (body frame)
   *  lies at back(q) in the mesh's frame. */
  back: Affine;
}

/** The pin for a head moved by `head` relative to the body, the warp
 *  updated to it. */
export function neckPin(warp: NeckWarp, head: Affine): NeckPin {
  warp.update(head);
  return { warp, back: invert(head) };
}

/** What to add to a band vertex resting at `rest` (the mesh's frame) to
 *  put it where the warp puts the layers under it. */
export function neckPinOffset(pin: NeckPin, rest: Point): Point {
  if (rest.y <= pin.warp.ys[1]) return { x: 0, y: 0 };
  const q = apply(pin.back, pin.warp.at(rest));
  return { x: q.x - rest.x, y: q.y - rest.y };
}
