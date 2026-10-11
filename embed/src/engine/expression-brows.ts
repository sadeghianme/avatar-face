/**
 * The brows as rigid strips (docs/emotions.md, "The brows"). A brow keeps
 * its thickness and its hair: every mesh vertex of a triangle the hair
 * lies in (the band measured on the picture, expression-brow-band.ts, or
 * the landmarks' band where the picture could not tell) takes the brow's
 * displacement whole, so no triangle with hair in it is stretched. A brow
 * changes shape only by how that displacement varies along it, from the
 * inner end through the middle to the outer end (smoothly, a quadratic
 * through the three): a whole lift, a slant, an arch, a knit toward the
 * midline. The skin takes the motion up: above, the forehead compresses,
 * fading to nothing well below the hairline (the outline never moves);
 * below, the lid's fold stretches down to the lash line, which stays: the
 * lids, their corners and the irises are never moved by a brow.
 *
 * A brow's rise is measured in the brow-to-lid distance under it (the
 * hair's lower edge to the lash line, at rest, the two brows' mean along
 * the brow, so a symmetric pose stays symmetric): a lift is a share of the
 * skin it has to stretch, so a deep-set eye with its brow on the lid lifts
 * less in pixels and is stretched no more than an open one. A brow's knit
 * is in IODs.
 */
import type { Point } from "./geometry";
import { EYE_CORNERS, IRISES, LANDMARK_COUNT, LOWER_LIDS, UPPER_LIDS } from "./landmarks";
import { BROW_CAP, type BrowPose } from "./expression-table";
import { landmarkBand, type BrowBand } from "./expression-brow-band";
import { browCaps, type BrowCaps, type StripLandmarks } from "./expression-brow-caps";
import {
  lidLine,
  midlineKeep,
  OUTLINE_FADE,
  outlineAbove,
  smoothstep,
  toCanvas,
  type FaceFrame,
} from "./expression-weights";

/** The skin round the hair that moves with it, IODs past each edge. */
const PAD = 0.025;
/** The forehead above a brow: still this far inside the face's outline
 *  (the hairline), IODs; compressed evenly between it and the brow; and a
 *  brow lifts at most this share of the room it has there, straight up,
 *  so the forehead is never pressed to less than 45% (a cartoon's forehead
 *  is short: its brows lifted fully folded it against the hairline); its
 *  skin is held still only this near the outline's side, IODs. */
const FOREHEAD = { still: 0.06, lift: 0.55, side: 0.06 } as const;
/** Past a brow's ends (toward the temple, toward the midline) its move
 *  fades out over this, IODs. */
const END_FADE = 0.16;
/** A hair vertex this near the outline is let go of over this, IODs: the
 *  outline is still, so a brow's tail at the temple bends a little there. */
const RIGID_OUTLINE_FADE = 0.08;
/** A hair triangle's corner this near the lid's line (IODs) does not move
 *  whole with the brow: on a brow that sits low over the eye (mehdi_avatar)
 *  the hair's triangles reach down to the lid's crease, and moving that
 *  whole stretched the few pixels of lid under it into a dark smear. It
 *  takes the fold's share instead (the hair's lowest strands stretch a
 *  little). */
const CLEAR_OF_LID = 0.06;
/** Skin this near the lid's line (IODs) is let go of: it stays. */
const NEAR_LID = 0.09;
/** The brow-to-lid distance's bounds, IODs. */
const UNIT = { least: 0.12, most: 0.4 } as const;
/** Every lid landmark, the eye corners and the irises: never a brow's. */
const EYE: ReadonlySet<number> = new Set([
  ...UPPER_LIDS.flat(),
  ...LOWER_LIDS.flat(),
  ...EYE_CORNERS.flat(),
  ...IRISES.flatMap(([c, rim]) => [c, ...rim]),
]);

/** One brow on one face: the landmarks it moves, where each lies along it
 *  (0 inner .. 1 outer), how much of its move each takes, the brow-to-lid
 *  distance there and the most it lifts there (IODs). */
interface Strip {
  readonly side: 0 | 1;
  readonly index: Int32Array;
  readonly share: Float64Array;
  readonly weight: Float64Array;
  readonly unit: Float64Array;
  readonly most: Float64Array;
  /** The most it lowers there, IODs, and the most it is drawn toward the
   *  midline (a knit), IODs. */
  readonly least: Float64Array;
  readonly inward: Float64Array;
}

/** One brow's moved landmarks before the mesh's caps: the forehead's own
 *  cap on its lift, IODs (FOREHEAD.lift of the room). */
interface Laid extends StripLandmarks {
  readonly most: readonly number[];
}

/** A band as a polyline with its length shares. */
interface Line {
  readonly centre: readonly Point[];
  readonly half: readonly number[];
  readonly shares: readonly number[];
}

export class BrowRig {
  private readonly strips: [Strip, Strip];
  private readonly shift = { x: 0, y: 0 };

  /**
   * The brows of the face whose rest landmarks are `local` (face frame),
   * their distances to the outline `outline` (IODs), its triangles
   * `triangles` (landmark indices) and each brow's hair `bands` as the
   * picture showed it (null: the landmarks' band), and how much more than
   * a photo's its skin may be pressed and stretched (`slack`).
   */
  constructor(
    local: readonly Point[],
    outline: Float64Array,
    private readonly frame: FaceFrame,
    triangles: readonly (readonly [number, number, number])[],
    bands: readonly [BrowBand | null, BrowBand | null],
    slack = 1
  ) {
    const lines = [lineOf(bands[0] ?? landmarkBand(local, 0)), lineOf(bands[1] ?? landmarkBand(local, 1))];
    const lids = [lidLine(local, 0, true), lidLine(local, 1, true)];
    // The brow-to-lid distance and the forehead's room along each brow,
    // the two brows' mean at each share of the way.
    const unitOf = (line: Line, side: 0 | 1) => (t: number) => {
      const c = alongLine(line, t);
      return lids[side](c.p.x) - (c.p.y + c.half);
    };
    const units = [unitOf(lines[0], 0), unitOf(lines[1], 1)];
    const unit = (t: number) => Math.max(UNIT.least, Math.min(UNIT.most, (units[0](t) + units[1](t)) / 2));
    const roomOf = (line: Line) => (t: number) => {
      const c = alongLine(line, t);
      return Math.max(0, outlineAbove(local, { x: c.p.x, y: c.p.y - c.half }) - FOREHEAD.still);
    };
    const rooms = [roomOf(lines[0]), roomOf(lines[1])];
    const room = (t: number) => Math.min(rooms[0](t), rooms[1](t));
    const laid = [0, 1].map((side) =>
      strip(local, outline, side as 0 | 1, lines[side], lids[side], triangles, unit, room)
    );
    const caps = browCaps(local, triangles, laid, slack);
    this.strips = [capped(laid[0], caps[0]), capped(laid[1], caps[1])];
  }

  /** How much of `side`'s brow move landmark `i` takes, and where along
   *  the brow (0 inner .. 1 outer). */
  weightOf(side: 0 | 1, i: number): { weight: number; share: number } {
    const s = this.strips[side];
    const k = s.index.indexOf(i);
    return k < 0 ? { weight: 0, share: 0 } : { weight: s.weight[k], share: s.share[k] };
  }

  /** The brow-to-lid distance at landmark `i` of `side`'s brow, IODs (0
   *  for one the brow does not move). */
  unitAt(side: 0 | 1, i: number): number {
    const s = this.strips[side];
    const k = s.index.indexOf(i);
    return k < 0 ? 0 : s.unit[k];
  }

  /** Move the landmarks in `pts` by each brow's pose (null: still), scaled
   *  by `gain`, capped (BROW_CAP). */
  apply(pts: Point[], poses: readonly [BrowPose | null, BrowPose | null], gain: number): void {
    for (const s of this.strips) {
      const pose = poses[s.side];
      if (!pose || !(gain > 0)) continue;
      const sign = s.side ? 1 : -1;
      const [ix, iy] = limited(pose.inner, gain),
        [mx, my] = limited(pose.mid, gain),
        [ox, oy] = limited(pose.outer, gain);
      for (let k = 0; k < s.index.length; k++) {
        const t = s.share[k];
        // The quadratic through the inner end (0), the middle (½) and the
        // outer end (1).
        const a = 2 * t * t - 3 * t + 1,
          b = 4 * t - 4 * t * t,
          c = 2 * t * t - t;
        const out = Math.max(-s.inward[k], ix * a + mx * b + ox * c);
        const down = Math.max(-s.most[k], Math.min(s.least[k], (iy * a + my * b + oy * c) * s.unit[k]));
        toCanvas(this.frame, sign * out * s.weight[k], down * s.weight[k], this.shift);
        const p = pts[s.index[k]];
        p.x += this.shift.x;
        p.y += this.shift.y;
      }
    }
  }
}

/** A pose's control `v` at `gain`, capped: [knit IODs, rise in units]. */
function limited(v: readonly [number, number], gain: number): [number, number] {
  const clamp = (x: number, m: number) => Math.max(-m, Math.min(m, x));
  return [clamp(v[0] * gain, BROW_CAP.knit), clamp(v[1] * gain, BROW_CAP.rise)];
}

function lineOf(band: BrowBand): Line {
  const len = [0];
  for (let k = 1; k < band.centre.length; k++)
    len.push(len[k - 1] + Math.hypot(band.centre[k].x - band.centre[k - 1].x, band.centre[k].y - band.centre[k - 1].y));
  const total = Math.max(1e-6, len[len.length - 1]);
  return { centre: band.centre, half: band.half, shares: len.map((l) => l / total) };
}

/** The band's centre and half thickness at share `t` of the way along it. */
function alongLine(line: Line, t: number): { p: Point; half: number } {
  const { centre, half, shares } = line;
  let k = 1;
  while (k < shares.length - 1 && shares[k] < t) k++;
  const u = Math.max(0, Math.min(1, (t - shares[k - 1]) / Math.max(1e-9, shares[k] - shares[k - 1])));
  return {
    p: {
      x: centre[k - 1].x + (centre[k].x - centre[k - 1].x) * u,
      y: centre[k - 1].y + (centre[k].y - centre[k - 1].y) * u,
    },
    half: half[k - 1] + (half[k] - half[k - 1]) * u,
  };
}

/** The share along `line` (0 inner .. 1 outer) of its column at face-frame
 *  `x`, held at the ends. */
function shareAt(line: Line, x: number): number {
  const c = line.centre;
  const dir = Math.sign(c[c.length - 1].x - c[0].x) || 1;
  const u = (x - c[0].x) * dir;
  if (u <= 0) return 0;
  for (let k = 1; k < c.length; k++) {
    const span = (c[k].x - c[k - 1].x) * dir;
    const v = (x - c[k - 1].x) * dir;
    if (v <= span)
      return (
        line.shares[k - 1] + (line.shares[k] - line.shares[k - 1]) * Math.max(0, Math.min(1, v / Math.max(1e-9, span)))
      );
  }
  return 1;
}

/** `side`'s brow strip on the face `local`. */
function strip(
  local: readonly Point[],
  outline: Float64Array,
  side: 0 | 1,
  line: Line,
  lid: (x: number) => number,
  triangles: readonly (readonly [number, number, number])[],
  unit: (t: number) => number,
  room: (t: number) => number
): Laid {
  const rigid = hairVertices(local, line, triangles, lid);
  const index: number[] = [],
    along: number[] = [],
    weight: number[] = [],
    units: number[] = [],
    most: number[] = [];
  for (let i = 0; i < Math.min(local.length, LANDMARK_COUNT); i++) {
    if (EYE.has(i)) continue;
    const p = local[i];
    if (p.y >= lid(p.x)) continue;
    const near = nearest(line, p);
    let w: number;
    if (rigid.has(i)) {
      // The hair's own triangles: whole, so they keep their shape.
      w = smoothstep(outline[i] / RIGID_OUTLINE_FADE);
    } else {
      const v = near.across,
        h = near.half + PAD;
      if (v < -h) {
        // Evenly down to nothing short of the hairline straight above: the
        // forehead compresses (as the brow's lift is capped by the same
        // room, a column of it is never pressed below FOREHEAD's share);
        // only the outline itself, and a narrow band inside it, stays.
        const above = -v - h,
          left = outlineAbove(local, p) - FOREHEAD.still;
        w = left > 0 ? (left / (above + left)) * smoothstep(outline[i] / FOREHEAD.side) : 0;
        w *= 1 - smoothstep(near.beyond / END_FADE);
      } else if (v <= h) w = 1;
      else {
        // Down to the lash line linearly: the lid's fold stretches; and
        // nothing just above the lid's line (beside the eye's corners it
        // is the corner's height: the canthus and the nose's side stay).
        const gap = lid(p.x) - (near.y + near.half);
        w = gap > 0.01 ? Math.max(0, 1 - (v - h) / gap) * smoothstep((lid(p.x) - p.y) / NEAR_LID) : 0;
      }
      if (v >= -h) w *= (1 - smoothstep(near.beyond / END_FADE)) * smoothstep(outline[i] / OUTLINE_FADE);
    }
    w *= midlineKeep(p.x, side);
    if (!(w > 1e-4)) continue;
    // Where along the brow, by its column (x): the landmarks over and
    // under each other move as one column, so the hair between them keeps
    // its height whatever caps the move.
    const t = shareAt(line, p.x);
    index.push(i);
    along.push(t);
    weight.push(w);
    units.push(unit(t));
    most.push(FOREHEAD.lift * room(t));
  }
  return { side, index, share: along, weight, unit: units, most };
}

/** `strip` with the caps `caps` laid on it, in typed arrays. */
function capped(strip: Laid, caps: BrowCaps): Strip {
  return {
    side: strip.side,
    index: Int32Array.from(strip.index),
    share: Float64Array.from(strip.share),
    weight: Float64Array.from(strip.weight),
    unit: Float64Array.from(strip.unit),
    most: Float64Array.from(strip.most, (m, k) => Math.min(m, caps.up[k])),
    least: Float64Array.from(caps.down),
    inward: Float64Array.from(caps.inward),
  };
}

/**
 * Every landmark of a triangle the brow's hair (its band, padded) lies in,
 * but none of the eye's and none within CLEAR_OF_LID of the lash line:
 * those triangles move whole.
 */
function hairVertices(
  local: readonly Point[],
  line: Line,
  triangles: readonly (readonly [number, number, number])[],
  lid: (x: number) => number
): Set<number> {
  // The band as points: along it at quarter steps of each span, across it
  // at its two padded edges and its centre.
  const probes: Point[] = [];
  for (let k = 0; k + 1 < line.centre.length; k++) {
    for (let u = 0; u < 1 + 1e-9; u += 0.25) {
      const t = line.shares[k] + (line.shares[k + 1] - line.shares[k]) * u;
      const c = alongLine(line, t);
      for (const s of [-1, 0, 1]) probes.push({ x: c.p.x, y: c.p.y + s * (c.half + PAD) });
    }
  }
  const out = new Set<number>();
  for (const tri of triangles) {
    if (tri.some((i) => i >= IRISES[0][0])) continue;
    const [a, b, c] = tri.map((i) => local[i]);
    if (probes.some((p) => inside(p, a, b, c))) for (const i of tri) out.add(i);
  }
  for (const i of [...out]) if (EYE.has(i) || local[i].y > lid(local[i].x) - CLEAR_OF_LID) out.delete(i);
  return out;
}

function inside(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const neg = d1 < 0 || d2 < 0 || d3 < 0,
    pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Where `p` lies against the band `line`: the share `t` along it, its
 * signed distance `across` its centre (+ toward the face's bottom), the
 * centre's y and the half thickness there, and how far `beyond` the band's
 * ends it is (0 within them), IODs.
 */
function nearest(line: Line, p: Point): { t: number; across: number; y: number; half: number; beyond: number } {
  const c = line.centre;
  let best = { t: 0, across: 0, y: 0, half: 0, beyond: 0, d: Infinity };
  for (let k = 0; k + 1 < c.length; k++) {
    const a = c[k],
      b = c[k + 1];
    const vx = b.x - a.x,
      vy = b.y - a.y;
    const len2 = Math.max(1e-12, vx * vx + vy * vy);
    const raw = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    const u = Math.max(0, Math.min(1, raw));
    const qx = a.x + vx * u,
      qy = a.y + vy * u;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best.d) {
      const len = Math.sqrt(len2);
      // The normal that points down the face.
      let nx = -vy / len,
        ny = vx / len;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const ends = (k === 0 && raw < 0 ? -raw : 0) + (k === c.length - 2 && raw > 1 ? raw - 1 : 0);
      const t = line.shares[k] + (line.shares[k + 1] - line.shares[k]) * raw;
      const half = line.half[k] + (line.half[k + 1] - line.half[k]) * u;
      best = { t, across: (p.x - qx) * nx + (p.y - qy) * ny, y: qy, half, beyond: ends * len, d };
    }
  }
  return best;
}
