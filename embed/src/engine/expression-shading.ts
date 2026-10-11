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
import { EXPRESSIONS, SHAPE_NAMES, SKIN_CUES, type ShapeName, type SkinCue } from "./expression-table";
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
export function cueStrengths(mix: ShapeMix, gain: number, capped = true): Record<SkinCue, number> {
  const out = Object.fromEntries(SKIN_CUES.map((c) => [c, 0])) as Record<SkinCue, number>;
  for (const shape of SHAPE_NAMES) {
    const cues = EXPRESSIONS[shape].cues;
    if (!cues || !(mix[shape] > 0)) continue;
    for (const c of SKIN_CUES) out[c] += (cues[c] ?? 0) * mix[shape];
  }
  for (const c of SKIN_CUES) out[c] = capped ? Math.min(1, out[c] * gain) : out[c] * gain;
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

/** One soft dab: an ellipse at (x, y) turned `angle`, `rx` along and `ry`
 *  across, its core at alpha `a`, fading on the BELL. */
export interface Dab {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly rx: number;
  readonly ry: number;
  readonly a: number;
}

/**
 * Soft dabs along `line`: each a bell `width` px across (an ellipse longer
 * along the line), at alpha `alpha` at its core, tapering in width and
 * strength to nothing at both ends.
 */
function dabs(line: readonly Point[], width: number, alpha: number, out: Dab[]): void {
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
    out.push({
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      rx: r * DAB.long,
      ry: r,
      a: Math.min(1, (((alpha * taper) / OVERLAP) * (width * DAB.apart)) / step),
    });
  }
}

/** A soft fold `width` px across round `line`, about `dark` of the light at
 *  its core (with FOLD_MODE). */
function shade(line: readonly Point[], width: number, dark: number, out: Dab[]): void {
  dabs(line, width, dark / FOLD_DEPTH, out);
}

/** A soft band of light `width` px across round `line`, adding about
 *  `bright` at its core (with LIGHT_MODE). */
function light(line: readonly Point[], width: number, bright: number, out: Dab[]): void {
  dabs(line, width, bright / DODGE_GAIN, out);
}

/** A soft round lift of light at `c`, `r` px, adding about `bright` at its
 *  centre (with LIGHT_MODE). */
function lift(c: Point, r: number, bright: number, out: Dab[]): void {
  out.push({ x: c.x, y: c.y, angle: 0, rx: r, ry: r, a: Math.min(1, bright / DODGE_GAIN) });
}

/** A fold darkens: "multiply" by a warm shadow tone, so each channel is a
 *  share of itself (blue and green a little more than red, as light lost
 *  under skin is: a fold in black alone read grey and drawn). A lift
 *  lightens: "color-dodge" with a dark grey g divides by 1 - g (a gain of a
 *  ninth, DODGE_GAIN: small, so a bright channel is not clipped at white
 *  while the others still rise, which would grey the skin). */
interface Ink {
  readonly mode: GlobalCompositeOperation;
  readonly rgb: readonly [number, number, number];
}
const FOLD_INK: Ink = { mode: "multiply", rgb: FOLD };
const LIGHT_INK: Ink = { mode: "color-dodge", rgb: [DODGE, DODGE, DODGE] };

/** A piece of a cue: the landmarks it is carried by, and its dabs laid on
 *  landmarks `pts` at the cue's strength `k`. */
interface Piece {
  readonly ink: Ink;
  readonly anchors: readonly number[];
  readonly lay: (pts: readonly Point[], f: Frame, k: number, out: Dab[]) => void;
}

/** Each cue's pieces; `central` the forehead's for concern (a few short
 *  folds in its middle only). */
function piecesOf(cue: SkinCue, central: boolean): Piece[] {
  switch (cue) {
    case "foreheadLines": {
      const folds = central ? CENTRAL_FOLDS : FOREHEAD_FOLDS;
      return [{ ink: FOLD_INK, anchors: FOREHEAD_ANCHORS, lay: (pts, f, k, out) => forehead(pts, f, folds, k, out) }];
    }
    case "glabellaLines":
      return [{ ink: FOLD_INK, anchors: GLABELLA_ANCHORS, lay: glabella }];
    case "nasolabial":
      return ([0, 1] as const).flatMap((side) => [
        {
          ink: FOLD_INK,
          anchors: NASOLABIAL_ANCHORS[side],
          lay: (pts: readonly Point[], f: Frame, k: number, out: Dab[]) =>
            shade(nasolabialLine(pts, f, side), 0.11 * f.iod, DARKEST * 0.45 * k, out),
        },
        {
          ink: LIGHT_INK,
          anchors: NASOLABIAL_ANCHORS[side],
          lay: (pts: readonly Point[], f: Frame, k: number, out: Dab[]) =>
            light(
              offset(nasolabialLine(pts, f, side), 0.055 * f.iod * (side ? -1 : 1)),
              0.1 * f.iod,
              BRIGHTEST * 0.5 * k,
              out
            ),
        },
      ]);
    case "cheekLift":
      return ([0, 1] as const).map((side) => ({
        ink: LIGHT_INK,
        anchors: CHEEK_ANCHORS[side],
        lay: (pts: readonly Point[], f: Frame, k: number, out: Dab[]) =>
          lift(at(f, pts[side ? 280 : 50], 0, -0.02), 0.26 * f.iod, BRIGHTEST * 0.5 * k, out),
      }));
    case "crowsFeet":
      // Only a strong smile's: from half strength up.
      return ([0, 1] as const).map((side) => ({
        ink: FOLD_INK,
        anchors: CROWS_ANCHORS[side],
        lay: (pts: readonly Point[], f: Frame, k: number, out: Dab[]) =>
          crowsFeet(pts, f, side, Math.max(0, (k - 0.5) / 0.5), out),
      }));
  }
}

/**
 * What one shape paints, one sprite per piece (a forehead's folds, one
 * side's nasolabial fold, its band of light, its cheek's lift, its crow's
 * feet), at that cue's strength in the table, carried by the piece's own
 * anchors. One sprite per piece rather than per shape keeps each drawn
 * rectangle tight: a smile's two sides in one sprite spanned the whole
 * face, and a canvas without a GPU composites every pixel of it.
 */
interface Layer {
  readonly key: string;
  readonly ink: Ink;
  readonly anchors: readonly number[];
  readonly lay: (pts: readonly Point[], f: Frame, out: Dab[]) => void;
}

/** Every shape's layers, made on first use (they close over the cue
 *  tables further down this module). */
let layersMade: ReadonlyMap<ShapeName, readonly Layer[]> | null = null;
const layers = (): ReadonlyMap<ShapeName, readonly Layer[]> => (layersMade ??= makeLayers());
const makeLayers = (): ReadonlyMap<ShapeName, readonly Layer[]> =>
  new Map(
    SHAPE_NAMES.flatMap((shape) => {
      const cues = EXPRESSIONS[shape].cues;
      if (!cues) return [];
      const pieces = SKIN_CUES.flatMap((c) =>
        (cues[c] ?? 0) > 0 ? piecesOf(c, shape === "concerned").map((p) => ({ p, k: cues[c]! })) : []
      );
      const shapeLayers = pieces.map(({ p, k }, n): Layer => ({
        key: `${shape}.${n}`,
        ink: p.ink,
        anchors: p.anchors,
        lay: (pts, f, out) => p.lay(pts, f, k, out),
      }));
      return [[shape, shapeLayers] as const];
    })
  );

/** The landmarks each piece is carried by. */
const BROW_TOPS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const FOREHEAD_ROW = [71, 68, 104, 69, 108, 337, 299, 333, 298, 301];
const FOREHEAD_ANCHORS = [...BROW_TOPS, ...FOREHEAD_ROW];
const GLABELLA_ANCHORS = [107, 336, 55, 285, 66, 296, 9, 8, 108, 337];
const NASOLABIAL_ANCHORS: readonly [readonly number[], readonly number[]] = [
  [129, 206, 61, 205, 216, 98, 50],
  [358, 426, 291, 425, 436, 327, 280],
];
const CHEEK_ANCHORS: readonly [readonly number[], readonly number[]] = [
  [50, 101, 118, 117, 205, 36],
  [280, 330, 347, 346, 425, 266],
];
const CROWS_ANCHORS: readonly [readonly number[], readonly number[]] = [
  [33, 133, 159, 145, 46, 226],
  [263, 362, 386, 374, 276, 446],
];

/** A piece rendered once: its alpha in an offscreen picture, the canvas
 *  point of its top-left when laid, the anchors where they were, and the
 *  alpha its peak stands for. */
interface Sprite {
  readonly picture: CanvasImageSource;
  readonly x0: number;
  readonly y0: number;
  /** Its size in sprite px (SPRITE_SCALE of the canvas's). */
  readonly w: number;
  readonly h: number;
  readonly ref: Float64Array;
  readonly peak: number;
}

/** An affine fit of anchors farther off than this (IODs, RMS) lays the
 *  piece anew: the face changed shape, not just place. */
const REFIT = 0.02;

/** The 2D canvas to render a sprite into: the page's (or an offscreen
 *  one), or, outside a browser, one like the context's own. */
type CanvasFactory = (w: number, h: number) => { getContext(id: "2d"): unknown } & CanvasImageSource;
function defaultFactory(ctx: CanvasRenderingContext2D): CanvasFactory {
  return (w, h) => {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h) as never;
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    }
    const Ctor = (ctx.canvas as unknown as { constructor: new (w: number, h: number) => never }).constructor;
    return new Ctor(w, h);
  };
}

/** The sprite's picture as the frame will draw it: an ImageBitmap where the
 *  canvas can give one (it stays on the GPU; a canvas filled by
 *  putImageData was uploaded again on every draw, a cost growing with its
 *  area: 1.4 ms a frame for a smile's two sprites). */
function frozen(canvas: CanvasImageSource): CanvasImageSource {
  const c = canvas as { transferToImageBitmap?: () => ImageBitmap };
  if (typeof c.transferToImageBitmap === "function") {
    try {
      return c.transferToImageBitmap();
    } catch {
      return canvas;
    }
  }
  return canvas;
}

/** The sprites' resolution, sprite px per canvas px: the folds are soft
 *  (their narrowest is 0.035 IOD across, several px at half scale), and a
 *  quarter of the pixels lays a smile's sprites four times faster. */
const SPRITE_SCALE = 0.5;
/** BELL by the squared radius, tabulated (no square root per pixel). */
const BELL_STEPS = 1024;
const BELL2 = Float32Array.from({ length: BELL_STEPS + 1 }, (_, k) => bell(Math.sqrt(k / BELL_STEPS)));

/** The value of BELL at `rho` (0 the centre, 1 the rim). */
function bell(rho: number): number {
  if (rho >= 1) return 0;
  for (let k = 1; k < BELL.length; k++) {
    const [r1, a1] = BELL[k];
    if (rho <= r1) {
      const [r0, a0] = BELL[k - 1];
      return a0 + ((a1 - a0) * (rho - r0)) / (r1 - r0);
    }
  }
  return 0;
}

/**
 * The skin cues of one face, painted as sprites: everything one shape
 * shades in one ink (a smile's folds; its lifts) is rendered once into
 * one alpha picture, laid on the face with that shape at full (`layout`),
 * and every frame drawn with ONE transformed drawImage, carried by an
 * affine fit of the landmarks it was laid on, at the shape's weight. A
 * frame costs one or two drawImage calls per shape on, not hundreds of
 * gradient fills (docs/emotions.md, "Skin cues"). Without a layout (a test,
 * a tool) a sprite is laid on the frame's own landmarks and laid anew when
 * the face changes shape beyond what an affine fit carries (REFIT).
 */
export class SkinCuePainter {
  private readonly sprites = new Map<string, Sprite>();
  /** How many sprites were laid (rendered) so far: a test's and a
   *  profiler's count. */
  laid = 0;
  /** How many sprites this frame may still lay. */
  private budget = 1;

  constructor(
    private readonly layout?: (shape: ShapeName) => readonly Point[] | null,
    private readonly factory?: CanvasFactory
  ) {}

  /** Paint the cues of `mix` at `gain` over the face whose landmarks this
   *  frame are `pts`. Paints nothing when no cue is on. */
  paint(ctx: CanvasRenderingContext2D, pts: readonly Point[], mix: ShapeMix, gain: number): void {
    if (!(gain > 0)) return;
    const s = cueStrengths(mix, gain);
    if (SKIN_CUES.every((c) => s[c] < FAINT)) return;
    // However many shapes sum in a cue, it is at most 1: every shape is
    // scaled alike by the most summed.
    const raw = cueStrengths(mix, gain, false);
    let most = 1;
    for (const c of SKIN_CUES) most = Math.max(most, raw[c]);
    const f = frameOf(pts);
    this.budget = 1;
    ctx.save();
    for (const [shape, shapeLayers] of layers()) {
      const on = (mix[shape] * gain) / most;
      if (!(on >= FAINT)) continue;
      for (const layer of shapeLayers) this.draw(ctx, shape, layer, pts, f, on);
    }
    ctx.restore();
  }

  private draw(
    ctx: CanvasRenderingContext2D,
    shape: ShapeName,
    layer: Layer,
    pts: readonly Point[],
    f: Frame,
    on: number
  ): void {
    const key = layer.key;
    let sprite: Sprite | null | undefined = this.sprites.get(key);
    let fit = sprite ? fitAffine(sprite.ref, pts, layer.anchors) : null;
    const relay = !this.layout && (!fit || fit.residual > REFIT * f.iod);
    if (!sprite || relay) {
      // With a layout, one sprite is laid a frame: a cue's first frames
      // are its faintest, and a smile's two sprites cost half each.
      if (this.layout && this.budget-- <= 0) return;
      const at = this.layout?.(shape) ?? pts;
      sprite = this.lay(ctx, key, layer, at);
      if (!sprite) return;
      fit = fitAffine(sprite.ref, pts, layer.anchors);
    }
    if (!fit) return;
    const alpha = Math.min(1, on * sprite.peak);
    if (!(alpha > 0)) return;
    ctx.save();
    ctx.globalCompositeOperation = layer.ink.mode;
    ctx.globalAlpha = alpha;
    const m = fit.m;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(sprite.picture, sprite.x0, sprite.y0, sprite.w / SPRITE_SCALE, sprite.h / SPRITE_SCALE);
    ctx.restore();
  }

  /** Render `layer` laid on landmarks `pts` into a new sprite. */
  private lay(ctx: CanvasRenderingContext2D, key: string, layer: Layer, pts: readonly Point[]): Sprite | null {
    const f = frameOf(pts);
    const list: Dab[] = [];
    layer.lay(pts, f, list);
    if (!list.length) return null;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const d of list) {
      const r = Math.max(d.rx, d.ry);
      x0 = Math.min(x0, d.x - r);
      y0 = Math.min(y0, d.y - r);
      x1 = Math.max(x1, d.x + r);
      y1 = Math.max(y1, d.y + r);
    }
    x0 = Math.floor(x0) - 1;
    y0 = Math.floor(y0) - 1;
    const w = Math.ceil((x1 + 1 - x0) * SPRITE_SCALE),
      h = Math.ceil((y1 + 1 - y0) * SPRITE_SCALE);
    if (!(w > 0 && h > 0) || w * h > 4e6) return null;
    const field = rasterise(list, x0, y0, w, h);
    let peak = 0;
    for (let k = 0; k < field.length; k++) peak = Math.max(peak, field[k]);
    if (!(peak > 0)) return null;
    // Cropped to what rounds to any alpha at all: the dabs' bounding
    // squares are mostly empty, and every drawn pixel is composited.
    const least = peak / 510;
    let i0 = w,
      j0 = h,
      i1 = -1,
      j1 = -1;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        if (field[j * w + i] >= least) {
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
          if (j < j0) j0 = j;
          if (j > j1) j1 = j;
        }
    const cw = i1 - i0 + 1,
      ch = j1 - j0 + 1;
    const canvas = (this.factory ?? defaultFactory(ctx))(cw, ch);
    const sctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!sctx) return null;
    const img = sctx.createImageData(cw, ch);
    const [r, g, b] = layer.ink.rgb;
    for (let j = 0; j < ch; j++)
      for (let i = 0; i < cw; i++) {
        const a = field[(j + j0) * w + i + i0] / peak;
        if (!(a > 0)) continue;
        const k = 4 * (j * cw + i);
        img.data[k] = r;
        img.data[k + 1] = g;
        img.data[k + 2] = b;
        img.data[k + 3] = Math.round(255 * a);
      }
    sctx.putImageData(img, 0, 0);
    const ref = new Float64Array(2 * layer.anchors.length);
    layer.anchors.forEach((i, k) => {
      ref[2 * k] = pts[i].x;
      ref[2 * k + 1] = pts[i].y;
    });
    const sprite: Sprite = {
      picture: frozen(canvas),
      x0: x0 + i0 / SPRITE_SCALE,
      y0: y0 + j0 / SPRITE_SCALE,
      w: cw,
      h: ch,
      ref,
      peak,
    };
    this.sprites.set(key, sprite);
    this.laid++;
    return sprite;
  }
}

/** The dabs' alphas summed over a w x h grid whose top-left is (x0, y0). */
function rasterise(list: readonly Dab[], x0: number, y0: number, w: number, h: number): Float32Array {
  const field = new Float32Array(w * h);
  const k = SPRITE_SCALE;
  for (const d of list) {
    const c = Math.cos(d.angle) / k,
      s = Math.sin(d.angle) / k;
    const r = Math.max(d.rx, d.ry);
    const ia = Math.max(0, Math.floor((d.x - r - x0) * k)),
      ib = Math.min(w - 1, Math.ceil((d.x + r - x0) * k));
    const ja = Math.max(0, Math.floor((d.y - r - y0) * k)),
      jb = Math.min(h - 1, Math.ceil((d.y + r - y0) * k));
    // A sprite pixel's centre in canvas px is x0 + (i + 0.5) / k.
    const ox = (x0 - d.x) * k + 0.5,
      oy = (y0 - d.y) * k + 0.5;
    const irx = 1 / d.rx,
      iry = 1 / d.ry;
    for (let j = ja; j <= jb; j++) {
      const dy = oy + j;
      const row = j * w;
      for (let i = ia; i <= ib; i++) {
        const dx = ox + i;
        const u = (dx * c + dy * s) * irx,
          v = (dy * c - dx * s) * iry;
        const r2 = u * u + v * v;
        if (r2 < 1) field[row + i] += d.a * BELL2[(r2 * BELL_STEPS) | 0];
      }
    }
  }
  return field;
}

/**
 * The affine map [a, b, c, d, e, f] (canvas: x' = a x + c y + e,
 * y' = b x + d y + f) that best carries the anchors from where they were
 * (`ref`) to `pts`, and the RMS distance it leaves (px); null when they are
 * degenerate.
 */
export function fitAffine(
  ref: Float64Array,
  pts: readonly Point[],
  anchors: readonly number[]
): { m: [number, number, number, number, number, number]; residual: number } | null {
  const n = anchors.length;
  let mx = 0,
    my = 0,
    nx = 0,
    ny = 0;
  for (let k = 0; k < n; k++) {
    mx += ref[2 * k];
    my += ref[2 * k + 1];
    nx += pts[anchors[k]].x;
    ny += pts[anchors[k]].y;
  }
  mx /= n;
  my /= n;
  nx /= n;
  ny /= n;
  let sxx = 0,
    sxy = 0,
    syy = 0,
    tx = 0,
    ty = 0,
    ux = 0,
    uy = 0;
  for (let k = 0; k < n; k++) {
    const x = ref[2 * k] - mx,
      y = ref[2 * k + 1] - my;
    const X = pts[anchors[k]].x - nx,
      Y = pts[anchors[k]].y - ny;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    tx += x * X;
    ty += y * X;
    ux += x * Y;
    uy += y * Y;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9)) return null;
  const a = (tx * syy - ty * sxy) / det,
    c = (ty * sxx - tx * sxy) / det;
  const b = (ux * syy - uy * sxy) / det,
    d = (uy * sxx - ux * sxy) / det;
  const e = nx - a * mx - c * my,
    f = ny - b * mx - d * my;
  let err = 0;
  for (let k = 0; k < n; k++) {
    const x = ref[2 * k],
      y = ref[2 * k + 1];
    err += (a * x + c * y + e - pts[anchors[k]].x) ** 2 + (b * x + d * y + f - pts[anchors[k]].y) ** 2;
  }
  return { m: [a, b, c, d, e, f], residual: Math.sqrt(err / n) };
}

/** One painter per context when the caller keeps none (a test, a tool). */
const PAINTERS = new WeakMap<object, SkinCuePainter>();

/**
 * Shade the skin cues of the expressions in `mix` (at `gain`: the line's
 * cue gain times the tuning's expression) over the face whose landmarks
 * this frame are `pts`, with `painter`'s sprites (or a painter kept for
 * `ctx`). Paints nothing when no cue is on.
 */
export function paintSkinCues(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  mix: ShapeMix,
  gain: number,
  painter?: SkinCuePainter
): void {
  if (!(gain > 0)) return;
  let p = painter ?? PAINTERS.get(ctx);
  if (!p) PAINTERS.set(ctx, (p = new SkinCuePainter()));
  p.paint(ctx, pts, mix, gain);
}

/* The forehead's room: the brows' tops (this frame) and the forehead's
 * middle row of landmarks above them (BROW_TOPS, FOREHEAD_ROW), inner to
 * outer across the face. */

/**
 * The forehead's folds: two or three gently wavy arcs between the brows and
 * the hairline, following the brows' own rise, each broken into a few
 * pieces of its own length, strength and waviness, so they read as skin
 * folding, not ruled lines (evenly spaced unbroken lines were the first
 * thing a viewer called painted); for concern only a short one in the
 * forehead's middle.
 */
function forehead(pts: readonly Point[], f: Frame, lines: readonly Fold[], k: number, out: Dab[]): void {
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
      shade(curve(ctrl, 18), 0.035 * f.iod, DARKEST * 0.35 * k * weight, out);
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
function glabella(pts: readonly Point[], f: Frame, k: number, list: Dab[]): void {
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
    shade(line, 0.07 * f.iod, DARKEST * 0.3 * k, list);
  }
}

/** The fold from the nose's wing past the mouth's corner (deepened by a
 *  shade, the cheek beside it lifted into the light by a band offset from
 *  it): from beside the wing, bowing out over the cheek's edge, to just
 *  past the corner. */
function nasolabialLine(pts: readonly Point[], f: Frame, side: 0 | 1): Point[] {
  const out = side ? 1 : -1;
  const [wing, fold_, corner] = side ? [358, 426, 291] : [129, 206, 61];
  const bend = lerp(pts[fold_], at(f, pts[corner], 0.06 * out, -0.05), 0.5);
  return curve(
    [at(f, pts[wing], 0.03 * out, 0.05), at(f, bend, 0.02 * out, 0), at(f, pts[corner], 0.06 * out, 0.04)],
    16
  );
}

/** A strong smile's crow's feet: three short faint lines fanning out from
 *  the eye's outer corner (painted only past half strength). */
function crowsFeet(pts: readonly Point[], f: Frame, side: 0 | 1, k: number, outDabs: Dab[]): void {
  if (!(k > 0)) return;
  const out = side ? 1 : -1;
  const corner = pts[EYE_CORNERS[side][0]]; // the outer corner
  for (const tilt of [-0.5, 0, 0.5]) {
    const from = at(f, corner, 0.06 * out, tilt * 0.03);
    const to = at(f, corner, 0.13 * out, tilt * 0.09);
    shade(curve([from, to], 8), 0.04 * f.iod, DARKEST * 0.4 * k, outDabs);
  }
}
