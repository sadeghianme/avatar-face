/**
 * The skin's own signs of an expression (docs/emotions.md, "Skin cues"): a
 * warp alone moves a face but a photo does not read as an emotion without
 * them, so faint folds are shaded over the warped picture along curves
 * placed by the frame's own landmarks (they move and turn with the face):
 * the forehead's horizontal folds for a surprise (and a few in its middle
 * for concern), the furrows between the brows for anger and concern, the
 * fold from the nose deepening and the cheek's apple lifting into the light
 * for a smile, and a strong smile's crow's feet.
 *
 * Luminance-relative, never a painted colour: a fold multiplies what is
 * there by a share of itself (canvas "multiply" with black at a low alpha),
 * a lift divides it by a little less than one ("color-dodge" with a grey),
 * so each channel scales alike and dark skin and light skin take the same
 * cue in their own tone and hue. Capped (DARKEST, BRIGHTEST). Feathered by
 * stacking narrower fills on a bell's profile (no canvas filter: a filtered
 * fill is a whole-canvas pass). Painted on the frame's 2D canvas after
 * either warp path has drawn the mesh there, so the GPU path and the 2D
 * fallback show the same pixels.
 */
import type { Point } from "./geometry";
import { EYE_CORNERS } from "./landmarks";
import { EXPRESSIONS, SHAPE_NAMES, SKIN_CUES, type SkinCue } from "./expression-table";
import type { ShapeMix } from "./expression-rig";

/** A fold's darkest at full strength (the share of the skin's own light it
 *  takes away at its core), and a lift's brightest (the share it adds). */
const DARKEST = 0.16;
const BRIGHTEST = 0.1;
/** Below this strength a cue is not painted. */
const FAINT = 0.02;
/** A soft dab's profile, centre to rim: a bell (alpha share), and how
 *  long a dab is along its line for its width; dabs are laid this share of
 *  their width apart, so they melt into one smooth fold. */
const BELL: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.3, 0.9],
  [0.55, 0.6],
  [0.8, 0.2],
  [1, 0],
];
const DAB = { long: 1.8, apart: 0.45 } as const;
/** The tone a fold multiplies by, and how much of the light (luma) it
 *  takes at full alpha. */
const FOLD = [150, 96, 82] as const;
const FOLD_DEPTH = 1 - (0.299 * FOLD[0] + 0.587 * FOLD[1] + 0.114 * FOLD[2]) / 255;
/** The grey a lift dodges with (0..255), and the gain it gives at full
 *  alpha: 1 / (1 - g) - 1. */
const DODGE = 26;
const DODGE_GAIN = 1 / (1 - DODGE / 255) - 1;
/** The dabs' summed alpha at a fold's core over one dab's: the bell's
 *  integral along the line over the spacing. */
const OVERLAP = (1.15 * DAB.long) / DAB.apart;

/** How strongly each cue is on, for the shapes in `mix` at `gain`. */
export function cueStrengths(mix: ShapeMix, gain: number): Record<SkinCue, number> {
  const out = Object.fromEntries(SKIN_CUES.map((c) => [c, 0])) as Record<SkinCue, number>;
  for (const shape of SHAPE_NAMES) {
    const cues = EXPRESSIONS[shape].cues;
    if (!cues || !(mix[shape] > 0)) continue;
    for (const c of SKIN_CUES) out[c] += (cues[c] ?? 0) * mix[shape];
  }
  for (const c of SKIN_CUES) out[c] = Math.min(1, out[c] * gain);
  return out;
}

/** The face's axes on this frame's landmarks: the eye line, the down axis
 *  and the IOD (canvas px). */
interface Frame {
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  iod: number;
}

function frameOf(pts: readonly Point[]): Frame {
  const l = { x: (pts[33].x + pts[133].x) / 2, y: (pts[33].y + pts[133].y) / 2 };
  const r = { x: (pts[263].x + pts[362].x) / 2, y: (pts[263].y + pts[362].y) / 2 };
  const iod = Math.max(1, Math.hypot(r.x - l.x, r.y - l.y));
  const ux = (r.x - l.x) / iod,
    uy = (r.y - l.y) / iod;
  return { ux, uy, nx: -uy, ny: ux, iod };
}

/** `p` moved `along` IODs along the eye line and `down` down the face. */
const at = (f: Frame, p: Point, along: number, down: number): Point => ({
  x: p.x + (along * f.ux + down * f.nx) * f.iod,
  y: p.y + (along * f.uy + down * f.ny) * f.iod,
});

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A smooth curve through `ctrl` (Catmull-Rom), sampled `n` times. */
function curve(ctrl: readonly Point[], n = 14): Point[] {
  if (ctrl.length === 2) return Array.from({ length: n }, (_, k) => lerp(ctrl[0], ctrl[1], k / (n - 1)));
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * (ctrl.length - 1);
    const i = Math.min(ctrl.length - 2, Math.floor(t));
    const u = t - i;
    const p0 = ctrl[Math.max(0, i - 1)],
      p1 = ctrl[i],
      p2 = ctrl[i + 1],
      p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const u2 = u * u,
      u3 = u2 * u;
    const c = (a: number, b: number, d: number, e: number) =>
      0.5 * (2 * b + (-a + d) * u + (2 * a - 5 * b + 4 * d - e) * u2 + (-a + 3 * b - 3 * d + e) * u3);
    out.push({ x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y) });
  }
  return out;
}

/** `line` moved `d` px along its normal (a left-to-right line's points down). */
function offset(line: readonly Point[], d: number): Point[] {
  const n = line.length;
  return line.map((p, k) => {
    const a = line[Math.max(0, k - 1)],
      b = line[Math.min(n - 1, k + 1)];
    const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
    return { x: p.x - ((b.y - a.y) / len) * d, y: p.y + ((b.x - a.x) / len) * d };
  });
}

/**
 * Soft dabs along `line`: each a bell `width` px across (an ellipse longer
 * along the line), the colour `colour` at alpha `alpha` at its core,
 * tapering in width and strength to nothing at both ends, composited by
 * `mode`.
 */
function dabs(
  ctx: CanvasRenderingContext2D,
  line: readonly Point[],
  width: number,
  colour: (a: number) => string,
  alpha: number,
  mode: GlobalCompositeOperation
): void {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [at, a] of BELL) g.addColorStop(at, colour(a));
  ctx.globalCompositeOperation = mode;
  ctx.fillStyle = g;
  // The line's length, then dabs evenly along it.
  const len = [0];
  for (let k = 1; k < line.length; k++)
    len.push(len[k - 1] + Math.hypot(line[k].x - line[k - 1].x, line[k].y - line[k - 1].y));
  const total = len[len.length - 1];
  const step = Math.max(1, width * DAB.apart * 0.6);
  let k = 1;
  for (let d = 0; d <= total; d += step) {
    while (k < line.length - 1 && len[k] < d) k++;
    const u = (d - len[k - 1]) / Math.max(1e-6, len[k] - len[k - 1]);
    const a = line[k - 1],
      b = line[k];
    const taper = Math.sin((Math.PI * d) / Math.max(1e-6, total));
    if (taper < 0.05) continue;
    const r = (width / 2) * (0.55 + 0.45 * taper);
    ctx.save();
    ctx.translate(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
    ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    ctx.scale(r * DAB.long, r);
    ctx.globalAlpha = Math.min(1, (((alpha * taper) / OVERLAP) * (width * DAB.apart)) / step);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Darken by a soft fold `width` px across round `line`, about `dark` of
 *  the light at its core: "multiply" by a warm shadow tone, so each
 *  channel is a share of itself (blue and green a little more than red, as
 *  light lost under skin is: a fold in black alone read grey and drawn). */
function shade(ctx: CanvasRenderingContext2D, line: readonly Point[], width: number, dark: number): void {
  dabs(ctx, line, width, (a) => `rgba(${FOLD.join(",")},${a})`, dark / FOLD_DEPTH, "multiply");
}

/** Lighten by a soft band `width` px across round `line`, adding about
 *  `bright` of the light at its core: "color-dodge" with a dark grey g
 *  divides by 1 - g (a gain of a ninth, DODGE_GAIN: small, so a bright
 *  channel is not clipped at white while the others still rise, which
 *  would grey the skin), at the alpha that makes it `bright`. */
function light(ctx: CanvasRenderingContext2D, line: readonly Point[], width: number, bright: number): void {
  dabs(ctx, line, width, (a) => `rgba(${DODGE},${DODGE},${DODGE},${a})`, bright / DODGE_GAIN, "color-dodge");
}

/** A soft lift of light round `c`, `r` px, adding about `bright` at its
 *  centre (color-dodge, as `light`). */
function lift(ctx: CanvasRenderingContext2D, c: Point, r: number, bright: number): void {
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
  for (const [at, a] of BELL) g.addColorStop(at, `rgba(${DODGE},${DODGE},${DODGE},${a})`);
  ctx.globalCompositeOperation = "color-dodge";
  ctx.globalAlpha = Math.min(1, bright / DODGE_GAIN);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Shade the skin cues of the expressions in `mix` (at `gain`: the line's
 * cue gain times the tuning's expression) over the face whose landmarks
 * this frame are `pts`. Paints nothing when no cue is on.
 */
export function paintSkinCues(ctx: CanvasRenderingContext2D, pts: readonly Point[], mix: ShapeMix, gain: number): void {
  if (!(gain > 0)) return;
  const s = cueStrengths(mix, gain);
  if (SKIN_CUES.every((c) => s[c] < FAINT)) return;
  const f = frameOf(pts);
  ctx.save();
  if (s.foreheadLines >= FAINT) forehead(ctx, pts, f, s.foreheadLines, mix.concerned > mix.surprised);
  if (s.glabellaLines >= FAINT) glabella(ctx, pts, f, s.glabellaLines);
  if (s.nasolabial >= FAINT) for (const side of [0, 1] as const) nasolabial(ctx, pts, f, side, s.nasolabial);
  if (s.cheekLift >= FAINT)
    for (const i of [50, 280]) lift(ctx, at(f, pts[i], 0, -0.02), 0.26 * f.iod, BRIGHTEST * 0.5 * s.cheekLift);
  if (s.crowsFeet >= FAINT) for (const side of [0, 1] as const) crowsFeet(ctx, pts, f, side, s.crowsFeet);
  ctx.restore();
}

/** The forehead's room: the brows' tops (this frame) and the forehead's
 *  middle row of landmarks above them, inner to outer across the face. */
const BROW_TOPS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const FOREHEAD_ROW = [71, 68, 104, 69, 108, 337, 299, 333, 298, 301];

/**
 * The forehead's folds: two or three gently wavy arcs between the brows and
 * the hairline, following the brows' own rise, each broken into a few
 * pieces of its own length, strength and waviness, so they read as skin
 * folding, not ruled lines (evenly spaced unbroken lines were the first
 * thing a viewer called painted); for concern only a short one in the
 * forehead's middle.
 */
function forehead(ctx: CanvasRenderingContext2D, pts: readonly Point[], f: Frame, k: number, central: boolean): void {
  const lines = central ? CENTRAL_FOLDS : FOREHEAD_FOLDS;
  for (const l of lines) {
    for (const [from, to, weight] of l.pieces) {
      const ctrl: Point[] = [];
      for (let j = 0; j <= 6; j++) {
        const t = from + ((to - from) * j) / 6;
        // Between the brows and the forehead's row, a little wavy, as high
        // on one side as the other (a fitted face's brow marks can sit
        // higher on one side: the folds came out slanting).
        const p = foldPoint(pts, t, l.up),
          q = foldPoint(pts, 1 - t, l.up);
        const lift = ((q.x - p.x) * f.nx + (q.y - p.y) * f.ny) / 2 / f.iod;
        ctrl.push(at(f, p, 0, lift + l.wave * Math.sin(l.phase + t * 11)));
      }
      shade(ctx, curve(ctrl, 18), 0.035 * f.iod, DARKEST * 0.35 * k * weight);
    }
  }
}

/** The point `up` of the way from the brows' tops to the forehead's row,
 *  at share `t` across the face (0 the picture's left outer end). */
function foldPoint(pts: readonly Point[], t: number, up: number): Point {
  const x = t * (BROW_TOPS.length - 1);
  const i = Math.min(BROW_TOPS.length - 2, Math.floor(x));
  const u = x - i;
  const brow = lerp(pts[BROW_TOPS[i]], pts[BROW_TOPS[i + 1]], u);
  const top = lerp(pts[FOREHEAD_ROW[i]], pts[FOREHEAD_ROW[i + 1]], u);
  return lerp(brow, top, up);
}

/** A forehead fold: how far up from the brows toward the forehead's row
 *  (0..1), its waviness (IODs) and phase, and its pieces: [from, to] along
 *  the brows (0 the picture's left outer end .. 1 its right) and strength. */
interface Fold {
  readonly up: number;
  readonly wave: number;
  readonly phase: number;
  readonly pieces: readonly (readonly [number, number, number])[];
}
const FOREHEAD_FOLDS: readonly Fold[] = [
  {
    up: 0.32,
    wave: 0.006,
    phase: 0.4,
    pieces: [
      [0.16, 0.44, 0.8],
      [0.52, 0.84, 0.9],
    ],
  },
  {
    up: 0.58,
    wave: 0.008,
    phase: 1.9,
    pieces: [
      [0.1, 0.34, 0.7],
      [0.4, 0.63, 1],
      [0.69, 0.9, 0.75],
    ],
  },
  {
    up: 0.82,
    wave: 0.007,
    phase: 3.1,
    pieces: [
      [0.3, 0.55, 0.5],
      [0.6, 0.74, 0.45],
    ],
  },
];
const CENTRAL_FOLDS: readonly Fold[] = [
  { up: 0.4, wave: 0.005, phase: 0.9, pieces: [[0.36, 0.64, 0.8]] },
  { up: 0.65, wave: 0.006, phase: 2.2, pieces: [[0.4, 0.58, 0.55]] },
];

/**
 * The furrows between the brows: a short, soft, near-vertical groove each
 * side of the midline rising from the brows' inner ends, leaning in toward
 * the nose at their foot, tapering to nothing at both ends.
 */
function glabella(ctx: CanvasRenderingContext2D, pts: readonly Point[], f: Frame, k: number): void {
  const mid = lerp(pts[107], pts[336], 0.5);
  for (const [i, out] of [
    [107, -1],
    [336, 1],
  ] as const) {
    const base = lerp(mid, pts[i], 0.6);
    const line = curve(
      [at(f, base, 0.008 * out, -0.13), at(f, base, 0.002 * out, -0.06), at(f, base, -0.006 * out, 0.01)],
      14
    );
    shade(ctx, line, 0.07 * f.iod, DARKEST * 0.3 * k);
  }
}

/** The fold from the nose's wing past the mouth's corner, deepened, the
 *  cheek beside it lifted into the light. */
function nasolabial(ctx: CanvasRenderingContext2D, pts: readonly Point[], f: Frame, side: 0 | 1, k: number): void {
  const out = side ? 1 : -1;
  const [wing, fold_, corner] = side ? [358, 426, 291] : [129, 206, 61];
  // From beside the nose's wing, bowing out over the cheek's edge, to just
  // past the mouth's corner.
  const bend = lerp(pts[fold_], at(f, pts[corner], 0.06 * out, -0.05), 0.5);
  const line = curve(
    [at(f, pts[wing], 0.03 * out, 0.05), at(f, bend, 0.02 * out, 0), at(f, pts[corner], 0.06 * out, 0.04)],
    16
  );
  shade(ctx, line, 0.11 * f.iod, DARKEST * 0.45 * k);
  light(ctx, offset(line, 0.055 * f.iod * -out), 0.1 * f.iod, BRIGHTEST * 0.5 * k);
}

/** A strong smile's crow's feet: three short faint lines fanning out from
 *  the eye's outer corner, only past half strength. */
function crowsFeet(ctx: CanvasRenderingContext2D, pts: readonly Point[], f: Frame, side: 0 | 1, k: number): void {
  const strength = Math.max(0, (k - 0.5) / 0.5);
  if (strength < FAINT) return;
  const out = side ? 1 : -1;
  const corner = pts[EYE_CORNERS[side][0]]; // the outer corner
  for (const tilt of [-0.5, 0, 0.5]) {
    const from = at(f, corner, 0.06 * out, tilt * 0.03);
    const to = at(f, corner, 0.13 * out, tilt * 0.09);
    shade(ctx, curve([from, to], 8), 0.04 * f.iod, DARKEST * 0.4 * strength);
  }
}
