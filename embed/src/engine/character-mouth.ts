import type { BlendWeights } from "../types";
import { INNER_LOWER, INNER_UPPER, LIP_CORNERS, LOWER_ROWS, UPPER_FACE, UPPER_ROWS, mouthFrame as lipFrame, type MouthFrame as LipFrame } from "./jaw-rig";

export { INNER_LOWER, INNER_UPPER } from "./jaw-rig";

/**
 * The mouth of a drawn or rendered character, and of an animal.
 *
 * The classic mouth was made for photographs of people: it cuts a lens out of
 * the lips, floods it with a gradient and sets incisors in it. On a cartoon
 * that is a photographic hole in flat art; on a dog it is a human mouth.
 * Chosen by the rig's render profile ("toon@1", "animal@2": kind-profile.ts),
 * this replaces it for those lines, in three parts:
 *
 *  - `CharacterField` moves the mesh: the lower lip, the chin and the jaw go
 *    down as one hinge, the lips narrow, spread and part for the other
 *    sounds. It owns the whole mouth region in place of the classic field,
 *    and reaches the chin and the muzzle, which the classic one stops short
 *    of.
 *  - `characterGeometry` reads the opening off the moved lip rings.
 *  - `paintCharacter` fills it: flat colours with the picture's own line for
 *    cel art, soft shading for a render or a photograph; a tongue that rises
 *    for /th/ and /d/, teeth only where the character wears them.
 *
 * Pure geometry and colour here; the engine supplies points and a context.
 */

export interface Pt { x: number; y: number }
export type Rgb = [number, number, number];

// MediaPipe's lip rows and corners are shared with the lower-face rig
// (jaw-rig.ts), which also hinges the jaw this field stops short of.
const CORNERS = LIP_CORNERS;
const OUTER_LOWER = LOWER_ROWS[3];

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** What a profile (and, later, the owner) can say about the mouth. */
export interface CharacterTraits {
  /** Incisors: none (a muzzle, a beak), or the upper row (a toon's grin). */
  teeth: "none" | "upper";
  tongue: boolean;
  /** Multiplies the jaw drop. 1 is the profile's own. */
  jaw: number;
}

/** The owner's mouth settings as the API serves them (the style is the
 *  backend's to apply to the rig; the engine reads the rest). */
export interface CharacterSettings {
  style?: "character" | "classic";
  teeth?: "none" | "upper";
  tongue?: boolean;
  jaw?: number;
}

/** What the API serves for an avatar whose mouth is the classic renderer but
 *  has character settings (the published snapshot's `mouth`). */
export interface ClassicMouthConfig {
  renderer: "classic";
  character?: CharacterSettings | null;
}

export const DEFAULT_TRAITS: CharacterTraits = { teeth: "upper", tongue: true, jaw: 1 };
export const TRAIT_LIMITS = { jaw: [0.5, 1.6] } as const;

/** The traits the owner may override, clamped, over a profile's own. */
export function mergeTraits(base: CharacterTraits, own: Partial<CharacterTraits> | null | undefined): CharacterTraits {
  if (!own) return base;
  const jaw = typeof own.jaw === "number" && Number.isFinite(own.jaw)
    ? Math.max(TRAIT_LIMITS.jaw[0], Math.min(TRAIT_LIMITS.jaw[1], own.jaw))
    : base.jaw;
  return {
    teeth: own.teeth === "none" || own.teeth === "upper" ? own.teeth : base.teeth,
    tongue: typeof own.tongue === "boolean" ? own.tongue : base.tongue,
    jaw,
  };
}

// --- The mesh ----------------------------------------------------------------

/** Jaw drop at full jawOpen, in mouth widths. A talking head's lip gap on an
 *  open vowel is about half the mouth's width; cartoons and muzzles open
 *  wider than people do. */
const JAW_GAIN = 0.5;
/** The share of the lower lip's drop the chin keeps: the lip slides over the
 *  jaw as it opens, so the chin travels less than the lip does. */
const CHIN_SHARE = 0.72;

export type MouthFrame = LipFrame;

/** The mouth's own frame in a mesh: its corners, its tilt, and a centre
 *  halfway between the lip seam and the corners' midpoint (the field's
 *  lens and ramps were tuned about that centre). */
export function mouthFrame(points: readonly Pt[]): MouthFrame {
  const f = lipFrame(points);
  const l = points[61], r = points[291];
  return { ...f, cx: (f.cx + (l.x + r.x) / 2) / 2, cy: (f.cy + (l.y + r.y) / 2) / 2 };
}


/**
 * How much of an /f/ or /v/ the weights are, 0..1: the lower lip drawn up
 * under the upper teeth. Needs the lips together (mouthClose) and drawn back
 * (mouthStretch), a little jaw, and not rounded; /p/ /b/ /m/ have no stretch,
 * /th/ and the vowels not enough mouthClose.
 */
export function tuckAmount(w: BlendWeights): number {
  const rounded = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
  const closed = smooth((w.mouthClose - 0.3) / 0.2);
  const back = smooth(w.mouthStretch / 0.1);
  const jaw = smooth((w.jawOpen - 0.03) / 0.04);
  return closed * back * jaw * (1 - Math.min(1, rounded * 2.5));
}

/**
 * The jaw and the lips as a displacement field over every vertex, built once
 * from the rest mesh. `apply` runs per frame.
 *
 * The first three terms are the classic field's own (a lens for the lower
 * lip, a lateral taper, a corner anchored half way); what is new is that the
 * jaw is a hinge all the way down: skin below the lips takes the chin's share
 * of the drop, wider with distance from the lip, so the whole lower face and
 * muzzle open instead of the lip alone.
 */
export class CharacterField {
  readonly frame: MouthFrame;
  private readonly n: number;
  private readonly role: Uint8Array;
  private readonly nxs: Float32Array; // along the mouth, in half-widths
  private readonly vs: Float32Array; // down the face, in mouth widths
  private readonly inner: Uint8Array;
  private readonly ramp: number;

  constructor(base: readonly Pt[], count = 478) {
    this.n = Math.min(count, base.length);
    this.frame = mouthFrame(base);
    const f = this.frame;
    this.role = new Uint8Array(this.n);
    this.inner = new Uint8Array(this.n);
    this.nxs = new Float32Array(this.n);
    this.vs = new Float32Array(this.n);
    for (const row of UPPER_ROWS) for (const i of row) if (i < this.n) this.role[i] = 1;
    for (const row of LOWER_ROWS) for (const i of row) if (i < this.n) this.role[i] = 2;
    for (const i of CORNERS) if (i < this.n) this.role[i] = 3;
    // The eyes, brows, nose and forehead: no mouth moves them. The field's
    // reach used to narrow a toon's nose on every rounded vowel.
    for (const i of UPPER_FACE) if (i < this.n) this.role[i] = 4;
    for (const i of [...INNER_UPPER, ...INNER_LOWER]) if (i < this.n) this.inner[i] = 1;
    for (let i = 0; i < this.n; i++) {
      const dx = base[i].x - f.cx, dy = base[i].y - f.cy;
      this.nxs[i] = ((dx * f.ax + dy * f.ay) / f.w) * 2;
      this.vs[i] = (dx * f.nx + dy * f.ny) / f.w;
    }
    // The outer lower lip sits this far below the seam; skin past it moves
    // with the jaw, so the ramp is as long as the lip is thick.
    let sum = 0;
    for (const i of OUTER_LOWER.slice(2, 7)) sum += this.vs[i];
    this.ramp = Math.max(0.05, (sum / 5) * 0.9);
  }

  /** Move `pts` (canvas points, at their rest positions on entry). */
  apply(pts: Pt[], w: BlendWeights, gain: number, traits: CharacterTraits): void {
    const f = this.frame;
    const W = f.w;
    const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
    const lensW = 1.05 - 0.3 * rounding;
    // /f/ /v/: the lower lip rises under the upper teeth. With teeth the lips
    // stay a tooth's height apart for them to show; a muzzle (no teeth) closes
    // to one clean seam, the lower lip a little raised.
    const tuckF = tuckAmount(w);
    const toothy = traits.teeth === "upper";
    const jaw = w.jawOpen * W * JAW_GAIN * traits.jaw * (1 - tuckF * (toothy ? 0.35 : 0.92));
    // Lip retraction opens the lips a little without the jaw: /s/ /ee/ show
    // teeth with the mouth nearly shut; /f/ /v/ tuck the lower lip. Same
    // measures the classic mouth uses.
    const retract =
      Math.min(1, w.mouthStretch * 1.5 + w.mouthSmile * 0.6) *
      (1 - rounding) ** 2 *
      Math.min(1, Math.max(0, (w.mouthStretch - 0.14) / 0.16));
    const tuck = w.mouthClose * Math.min(1, w.mouthStretch / 0.2) * (1 - rounding);
    const part = Math.max(retract * 0.075 * (toothy ? 1 : 1 - tuckF), tuck * 0.02 * (toothy ? 1 : 1 - tuckF), toothy ? tuckF * 0.085 : 0) * W;
    const drop = jaw + part * 0.6;
    const lift = jaw * (0.1 + 0.28 * rounding) + part * 0.4;
    const reach = W * 1.15;
    const spread = (w.mouthStretch * 0.26 + w.mouthSmile * 0.16 - w.mouthPucker * 0.32 - w.mouthFunnel * 0.18) * (W / 2);

    for (let i = 0; i < this.n; i++) {
      const role = this.role[i];
      if (role === 4) continue;
      const nxi = this.nxs[i];
      const vi = this.vs[i];
      const lens = Math.max(0, 1 - Math.pow(Math.abs(nxi) / lensW, 2.2));

      let da = 0; // along the mouth
      let dn = 0; // down the face

      // Lips narrow, spread and curl: a radial falloff round the mouth.
      // The lips move as one band: their rows share one falloff, by how far
      // along the mouth they are, or an outer row spreads less than the
      // inner one beside it and the drawn lip line crumples into a zigzag.
      const dist = role !== 0 ? Math.abs(nxi) * (W / 2) : Math.hypot(nxi * (W / 2), vi * W * 1.35);
      if (dist < reach) {
        const t = 1 - dist / reach;
        const fall = t * t * (3 - 2 * t);
        da += spread * nxi * fall;
        if (Math.abs(nxi) > 0.55) dn -= w.mouthSmile * W * 0.1 * (Math.abs(nxi) - 0.55) * fall;
        // The funnel opens the lips up and down. By the lip's own row, not by
        // which side of the seam it happens to sit on: the inner rows hug the
        // seam, and a sign that flips between neighbours is a step of several
        // px along the drawn lip line.
        const dir = role === 1 ? -1 : role === 2 ? 1 : role === 3 ? 0 : Math.max(-1, Math.min(1, vi / 0.06));
        dn += (dir < 0 ? 0.05 : 0.035) * dir * w.mouthFunnel * W * fall;
      }

      // The jaw.
      if (role === 2) dn += drop * lens - tuckF * W * (toothy ? 0.004 : 0.003) * lens;
      else if (role === 3) dn += drop * 0.5 * lens;
      else if (role === 1) dn -= lift * lens;
      else if (vi > 0) {
        const below = smooth(vi / this.ramp);
        const down = smooth(vi / 0.7);
        const widen = 1 + 1.3 * down;
        const lat = Math.max(0, 1 - Math.pow(Math.abs(nxi) / (lensW * widen), 2.2));
        dn += drop * below * (1 - (1 - CHIN_SHARE) * down) * lat;
      }
      // Closing: the inner lip is drawn to the seam.
      if (this.inner[i]) dn -= vi * W * w.mouthClose * 0.8;

      if (da !== 0 || dn !== 0) {
        pts[i].x += (da * f.ax + dn * f.nx) * gain;
        pts[i].y += (da * f.ay + dn * f.ny) * gain;
      }
    }
    // The cheeks follow in the engine's lower-face pass (jaw-rig.ts), for
    // every driver alike: they used to be pushed outward here as the jaw
    // dropped, and an opening jaw narrows a face.
  }
}

// --- The opening -------------------------------------------------------------

export interface Opening {
  upper: Pt[]; lower: Pt[];
  /** Mouth width, corner to corner, in px. */
  width: number;
  /** The widest the lips are apart, minus how far apart they rest, px. */
  gap: number;
  /** 0..1: how much of the opening to draw. */
  alpha: number;
  /** Upper and lower edges at their mid points. */
  midY: number;
}

/**
 * The opening, read off the moved inner lip rings. `restGap` is how far apart
 * the same rings sit on the closed mouth (a few px of lip thickness) and is
 * not an opening.
 */
export function characterOpening(
  pts: readonly Pt[],
  rest: readonly Pt[]
): Opening | null {
  const upper = INNER_UPPER.map((i) => pts[i]);
  const lower = INNER_LOWER.map((i) => pts[i]);
  const l = pts[78], r = pts[308];
  const width = Math.max(Math.hypot(r.x - l.x, r.y - l.y), 1);
  let gap = 0;
  for (let k = 1; k < upper.length - 1; k++) {
    const rg = rest[INNER_LOWER[k]].y - rest[INNER_UPPER[k]].y;
    gap = Math.max(gap, lower[k].y - upper[k].y - rg);
  }
  const ratio = gap / width;
  const alpha = smooth((ratio - 0.018) / 0.04);
  if (alpha <= 0.01) return null;
  const mid = (upper[5].y + lower[5].y) / 2;
  return { upper, lower, width, gap, alpha, midY: mid };
}

/** A smooth closed path through the opening's outline, corner to corner. */
export function openingPath(o: Opening, make: () => Path2D): Path2D {
  const outline = [...o.upper, ...o.lower.slice(1, -1).reverse()];
  const path = make();
  const n = outline.length;
  if (n < 3) return path;
  path.moveTo(outline[0].x, outline[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = outline[(i - 1 + n) % n];
    const p1 = outline[i];
    const p2 = outline[(i + 1) % n];
    const p3 = outline[(i + 2) % n];
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y
    );
  }
  path.closePath();
  return path;
}

// --- The picture's own colours ------------------------------------------------

/** What the painter takes from the picture, sampled once. */
export interface CharacterLook {
  /** Cel art: flat fills and a drawn line, not shading. */
  flat: boolean;
  /** The picture's darkest tone along the mouth: its line, or a deep shadow. */
  line: Rgb;
  lip: Rgb;
  skin: Rgb;
  /** How soft the picture's own edges are, as a share of the mouth's width
   *  (texture px over the mouth's width in the same px): the opening's edge
   *  is feathered by the same share of its width. The picture's sharpness
   *  (face-sharpness.ts: its crispest strong edges round the mouth and the
   *  eyes) when the engine has it; the width of the step across the lip
   *  seam (`edgeWidth`) only when it has none; DEFAULT_LOOK's last. */
  soft: number;
}

export const DEFAULT_LOOK: CharacterLook = {
  flat: false, line: [60, 28, 26], lip: [150, 90, 84], skin: [200, 150, 130], soft: 0.006,
};

/** The feather is never more than this share of the mouth's width: the
 *  photographic mouth's ceiling (mouth/aperture-feather.ts), so a soft
 *  picture of a small mouth does not get a feather that swallows it. */
export const SOFT_CEILING = 0.03;

/**
 * `CharacterLook.soft` from what the engine read of the picture.
 *
 * The sharpness (face-sharpness.ts, texture px) is the measure: a crisp
 * cel-art drawing has 1 px lines but a soft seam (a shadow in a crease,
 * 3 to 5 px wide in a crisp picture as in a soft one), and a smooth render
 * has soft lines and a soft seam, so the seam cannot tell them apart and
 * the sharpness does. The seam's step (`seamEdge`, clamped 1 to 4 px, as
 * the mouth always read it) is the fallback for a picture whose sharpness
 * is null (flat, or tainted); the default is the last resort.
 */
export function softness(sharpness: number | null | undefined, seamEdge: number | null, mouthWidth: number): number {
  const w = Math.max(mouthWidth, 1);
  if (typeof sharpness === "number" && Number.isFinite(sharpness) && sharpness > 0) return Math.min(SOFT_CEILING, sharpness / w);
  if (seamEdge !== null) return Math.max(1, Math.min(4, seamEdge)) / w;
  return DEFAULT_LOOK.soft;
}

/**
 * How wide the picture's edges are, in pixels, read across its mouth seam:
 * the contrast of the profile over its steepest step. A photograph of fur is
 * a pixel or two; a render a little more; an upscaled drawing, several.
 * The fallback measure of the look's softness (`softness`): the seam of a
 * closed mouth is a crease's shadow, as wide on a crisp picture as on a soft
 * one, which is why the picture's sharpness is read first.
 */
export function edgeWidth(pixel: (x: number, y: number) => Rgb | null, seam: readonly Pt[]): number | null {
  const widths: number[] = [];
  const from = Math.floor(seam.length * 0.25), to = Math.ceil(seam.length * 0.75);
  for (let k = from; k < to; k++) {
    const p = seam[k];
    const lum: number[] = [];
    for (let dy = -5; dy <= 5; dy++) {
      const c = pixel(p.x, p.y + dy);
      if (c) lum.push(luma(c));
    }
    if (lum.length < 8) continue;
    const contrast = Math.max(...lum) - Math.min(...lum);
    if (contrast < 25) continue;
    let steepest = 0;
    for (let i = 0; i + 1 < lum.length; i++) steepest = Math.max(steepest, Math.abs(lum[i + 1] - lum[i]));
    if (steepest > 0) widths.push(contrast / steepest);
  }
  if (!widths.length) return null;
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

export const luma = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
export const rgb = (c: Rgb, a = 1) =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;

/**
 * Cel art or not, and the picture's line colour, from `pixel(x, y)` in
 * texture pixels around a mouth of width `w` at (cx, cy).
 *
 * Flat art is told by its palette: a handful of colours cover nearly all of
 * the area round the mouth. A render's skin and a photograph's fur spread over
 * hundreds. The line is the darkest quarter of the samples on the mouth's own
 * seam, wherever the artist drew it. `sharpness` is the picture's, in the
 * same pixels (face-sharpness.ts), null or absent when it has none: the
 * look's softness (`softness`) is read from it, and from the seam only then.
 */
export function sampleLook(
  pixel: (x: number, y: number) => Rgb | null,
  seam: readonly Pt[],
  box: { cx: number; cy: number; w: number },
  lip: Rgb,
  skin: Rgb,
  sharpness: number | null = null
): CharacterLook {
  const bins = new Map<number, number>();
  let total = 0;
  const x0 = box.cx - box.w * 1.5, x1 = box.cx + box.w * 1.5;
  const y0 = box.cy - box.w * 0.9, y1 = box.cy + box.w * 1.5;
  const N = 28;
  // Cel art is told by two things together. Its palette: a handful of colours
  // cover nearly all of the area (a render's skin and a photograph's fur spread
  // over hundreds of bins; measured on real pictures: cartoons 0.85 to 0.87
  // in the top eight bins, renders and fur 0.33 to 0.42). And its texture:
  // neighbouring pixels are alike, as the MEDIAN step between them shows, so a
  // few hard edges (the drawn line) do not count against it, nor does the light
  // noise an AI-made drawing carries. A fur of a narrow range of browns fills
  // few bins too, but its median step is large.
  const steps: number[] = [];
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      const x = x0 + ((x1 - x0) * (a + 0.5)) / N, y = y0 + ((y1 - y0) * (b + 0.5)) / N;
      const c = pixel(x, y);
      if (!c) continue;
      const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
      bins.set(key, (bins.get(key) ?? 0) + 1);
      total++;
      const d = pixel(x + 1, y);
      if (d) steps.push(Math.max(Math.abs(c[0] - d[0]), Math.abs(c[1] - d[1]), Math.abs(c[2] - d[2])));
    }
  }
  let flat = false;
  if (total > 0) {
    const top = [...bins.values()].sort((p, q) => q - p).slice(0, 8).reduce((s, v) => s + v, 0);
    steps.sort((p, q) => p - q);
    const median = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
    flat = top / total >= 0.7 && median <= 4;
  }
  const dark: { l: number; c: Rgb }[] = [];
  for (const p of seam) {
    for (let dy = -3; dy <= 3; dy++) {
      const c = pixel(p.x, p.y + dy);
      if (c) dark.push({ l: luma(c), c });
    }
  }
  let line: Rgb = DEFAULT_LOOK.line;
  if (dark.length) {
    dark.sort((p, q) => p.l - q.l);
    line = dark[Math.floor(dark.length * 0.12)].c;
  }
  // The seam is read only for a picture without a sharpness: the measure
  // the sharpness replaced (see `softness`).
  const hasSharpness = typeof sharpness === "number" && Number.isFinite(sharpness) && sharpness > 0;
  const soft = softness(sharpness, hasSharpness ? null : edgeWidth(pixel, seam), box.w);
  return { flat, line, lip, skin, soft };
}

