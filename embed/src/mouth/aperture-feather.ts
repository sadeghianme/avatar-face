import type { MouthPoint } from "../mouth-extension";

/**
 * The feather of the photographic mouth's aperture.
 *
 * The interior (cavity, teeth, the inner lip) is painted into a layer of its
 * own and brought onto the face through a soft mask: the aperture, eroded by
 * half the feather and blurred by it, so the interior fades out INSIDE the
 * lip's edge, over about the width of the picture's own edges, and never
 * bleeds outward over the lip. Clipped to the pixel-hard aperture, as it
 * was, every edge in a soft picture (a scan, a smooth render, a warm photo)
 * was 2 to 5 px wide while the cavity and the teeth ended in a 1 px cut, and
 * the interior read as pasted in. The feather is the width of the picture's
 * crispest edges (face-sharpness.ts), and the corners of the aperture, the
 * acute tips of a smile, are kept crisp under it. The character mouth
 * softens its opening the same way, by its own measure of the picture
 * (character-paint.ts).
 */

/** The feather never under this, px: a hard clip is a 1 px cut, and the
 *  antialiasing of one is not a feather. A picture whose sharpness is
 *  unknown (flat, tainted) gets this. */
export const FEATHER_FLOOR = 1.2;
/** ...and never over this share of the mouth's width: past this the teeth
 *  fade into the lips and the mouth goes mushy (a very soft picture, or a
 *  small mouth upscaled). */
export const FEATHER_CEILING = 0.03;

const smooth = (t: number) => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/** The feather, px, for a mouth `width` px wide on a picture whose
 *  crispest edges are `edge` px wide in the same pixels (face-sharpness.ts,
 *  MouthSurfaceFrame.sharpness × pixelScale): the picture's own edge width,
 *  clamped; the floor when unknown. */
export function apertureFeather(width: number, edge?: number): number {
  const own = Number.isFinite(edge) && (edge as number) > 0 ? (edge as number) : 0;
  return Math.max(FEATHER_FLOOR, Math.min(FEATHER_CEILING * width, own));
}

/** How soft the picture is, 0 to 1, from its crispest edge width as a
 *  share of the mouth's width: 0 at a crisp photograph (the Reference,
 *  0.011), full at a smooth render or an upscaled snapshot (0.03). The rim
 *  halo outside the edge is scaled by it: a crisp picture's lip edge has
 *  no halo, nor has one whose sharpness is unknown. */
export function edgeSoftness(share?: number): number {
  if (!Number.isFinite(share)) return 0;
  return smooth(((share as number) - 0.01) / 0.02);
}

/** The mask's erosion (how far inside the edge its own edge sits) and its
 *  blur (Gaussian sigma), as shares of the feather. By the contrast-over-
 *  steepest-step measure of character-mouth.ts, a Gaussian edge is about
 *  2.5 sigma wide, so sigma 0.4 makes the mask's edge as wide as the
 *  feather; eroded by half of it, the alpha is 0.1 at the lip's edge and
 *  nothing (under 1/255) a feather outside it. */
export const MASK_ERODE = 0.5;
export const MASK_SIGMA = 0.4;

/** The normal CDF (Abramowitz & Stegun 7.1.26, within 1.5e-7). */
function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + (z < 0 ? -erf : erf));
}

/** The mask's alpha `d` px inside the aperture's edge (negative: outside),
 *  as the erosion and blur leave it: a Gaussian-blurred step at the eroded
 *  edge. This is the model of what the canvas does; the canvas is checked
 *  against it by eye and by the harness, the model by test. */
export function featherAlpha(d: number, feather: number): number {
  return normalCdf((d - MASK_ERODE * feather) / (MASK_SIGMA * feather));
}

/** The corners stay crisp: the hard aperture is stamped back over the
 *  feathered mask, whole at each mouth corner and gone this share of the
 *  mouth's width inward. Eroded and blurred alike everywhere, the mask
 *  rounded off the acute tips of a wide smile. */
export const CORNER_REACH = 0.2;

/** How much of the hard aperture is stamped back `distance` px from a
 *  corner whose stamp reaches `reach` px: 1 at the corner, 0 at the reach,
 *  smooth between. */
export function cornerWeight(distance: number, reach: number): number {
  return reach > 0 ? smooth(1 - distance / reach) : 0;
}

/** The mask's alpha `d` px inside the edge where the corner stamp is
 *  `corner` strong (cornerWeight): the feathered alpha and the stamp
 *  composited, one over the other (source-over of two alphas is their
 *  screen), so it is whole where either is, and outside the hard edge the
 *  stamp adds nothing. */
export function featherAlphaAt(d: number, feather: number, corner: number): number {
  const soft = featherAlpha(d, feather),
    hard = d > 0 ? corner : 0;
  return 1 - (1 - soft) * (1 - hard);
}

/** The stamp's radial gradient stops: cornerWeight, as a gradient's
 *  straight runs between stops follow it. */
export const CORNER_STOPS: readonly [number, number][] = [0, 0.25, 0.5, 0.75, 1].map(
  (t) => [t, cornerWeight(t, 1)] as [number, number]
);

/** Without canvas filters: the erosion and blur as rings stroked out of the
 *  filled aperture (destination-out), the widest first, each taking the
 *  alpha of its band down to the profile's value at the band's middle; the
 *  innermost, a sliver, clears the edge itself. A stair of nine steps for
 *  a slope, finer towards the edge where the slope is steepest. */
export function featherSteps(feather: number): { lineWidth: number; alpha: number }[] {
  const halves = [1.4, 1.15, 0.95, 0.8, 0.65, 0.5, 0.35, 0.2, 0.08];
  const steps: { lineWidth: number; alpha: number }[] = [];
  let kept = 1;
  for (let i = 0; i < halves.length; i++) {
    const last = i === halves.length - 1;
    const target = last ? 0 : featherAlpha(((halves[i] + halves[i + 1]) / 2) * feather, feather);
    steps.push({ lineWidth: 2 * halves[i] * feather, alpha: last ? 1 : 1 - target / kept });
    kept = target;
  }
  return steps;
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * A mouth-sized layer the interior is painted into, and the mask it is
 * brought through. Two canvases, made once, grown when the mouth needs
 * more; the layer's pixels are the face's (the context's transform is
 * carried over, shifted), so the interior is painted with the same
 * coordinates as before and lands on the same pixels. One blur per frame,
 * on a canvas no larger than the aperture and its feather.
 */
export class FeatheredLayer {
  private layer: HTMLCanvasElement | null = null;
  private mask: HTMLCanvasElement | null = null;
  private lc: CanvasRenderingContext2D | null = null;
  private mc: CanvasRenderingContext2D | null = null;
  /** Whether the layer's context honours `filter`; decided once. */
  private filters = false;
  private tried = false;
  /** This frame: the layer's origin and extent in device pixels, the
   *  transform the interior is painted under, and the device scale. */
  private x = 0;
  private y = 0;
  private w = 0;
  private h = 0;
  private matrix: Matrix = IDENTITY;
  private scale = 1;
  private open = false;

  private make(): boolean {
    if (this.tried) return this.lc !== null;
    this.tried = true;
    try {
      if (typeof document === "undefined") return false;
      const layer = document.createElement("canvas"),
        mask = document.createElement("canvas");
      const lc = layer.getContext("2d"),
        mc = mask.getContext("2d");
      if (!lc || !mc) return false;
      this.layer = layer;
      this.mask = mask;
      this.lc = lc;
      this.mc = mc;
      this.filters = typeof lc.filter === "string";
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The layer for this frame, its context transformed as `ctx` is (shifted
   * to the layer's own origin) and saved, so the interior is painted with
   * the face's coordinates; `end` brings it onto `ctx`. Null when no layer
   * can be had (no document, no context): the interior is then painted
   * straight onto `ctx`, clipped, as it always was.
   */
  begin(
    ctx: CanvasRenderingContext2D,
    points: readonly MouthPoint[],
    feather: number
  ): CanvasRenderingContext2D | null {
    if (!points.length || !this.make()) return null;
    const m = (typeof ctx.getTransform === "function" ? ctx.getTransform() : null) ?? IDENTITY;
    const matrix: Matrix = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) return null;
    this.matrix = matrix;
    this.scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of points) {
      const X = matrix.a * p.x + matrix.c * p.y + matrix.e,
        Y = matrix.b * p.x + matrix.d * p.y + matrix.f;
      if (X < x0) x0 = X;
      if (X > x1) x1 = X;
      if (Y < y0) y0 = Y;
      if (Y > y1) y1 = Y;
    }
    // Room for the mask's blur to tail off, and the inner lip's own blur.
    const margin = Math.ceil(feather * this.scale * 2 + 2);
    this.x = Math.floor(x0) - margin;
    this.y = Math.floor(y0) - margin;
    this.w = Math.ceil(x1) - Math.floor(x0) + 2 * margin;
    this.h = Math.ceil(y1) - Math.floor(y0) + 2 * margin;
    if (this.w > 8192 || this.h > 8192) return null;
    const layer = this.layer!,
      mask = this.mask!,
      lc = this.lc!;
    if (layer.width < this.w || layer.height < this.h) {
      layer.width = mask.width = Math.max(layer.width, this.w);
      layer.height = mask.height = Math.max(layer.height, this.h);
    }
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, this.w, this.h);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = "source-over";
    if (this.filters) lc.filter = "none";
    lc.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - this.x, matrix.f - this.y);
    lc.save();
    this.open = true;
    return lc;
  }

  /**
   * `draw`, painted onto the layer through one blur of `sigma` px: drawn on
   * the mask's canvas (free until `end`) under the layer's transform, then
   * brought over blurred, so a band of several strokes costs one filter
   * pass, not one per stroke (each filtered draw is a pass of its own, and
   * six of them cost five times the whole mask). Without filters, straight
   * onto the layer, unblurred.
   */
  blurred(draw: (ctx: CanvasRenderingContext2D) => void, sigma: number): void {
    if (!this.open) return;
    const lc = this.lc!,
      mc = this.mc!,
      { x, y, w, h, matrix } = this;
    if (!this.filters) {
      lc.save();
      draw(lc);
      lc.restore();
      return;
    }
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.clearRect(0, 0, w, h);
    mc.globalAlpha = 1;
    mc.globalCompositeOperation = "source-over";
    mc.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
    mc.save();
    draw(mc);
    mc.restore();
    lc.save();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = "source-over";
    lc.filter = `blur(${(sigma * this.scale).toFixed(2)}px)`;
    lc.drawImage(this.mask!, 0, 0, w, h, 0, 0, w, h);
    lc.restore();
  }

  /**
   * The layer through the mask onto `ctx`: the aperture filled, eroded by
   * half the feather (a stroke of the feather's width taken out of the
   * fill), blurred by 0.4 of it in place, and at each of `corners` the hard
   * aperture stamped back through a radial weight (whole at the corner,
   * gone `reach` px inward, in the face's units), kept of the layer
   * (destination-in), then drawn onto the face in device pixels, as it was
   * painted. The stamp is composited over the feathered mask, so the alpha
   * is whole where either is and nothing is added outside the hard edge
   * (featherAlphaAt).
   */
  end(
    ctx: CanvasRenderingContext2D,
    aperture: Path2D,
    feather: number,
    corners?: { points: readonly MouthPoint[]; reach: number }
  ): void {
    if (!this.open) return;
    this.open = false;
    const { x, y, w, h, matrix } = this;
    const lc = this.lc!,
      mc = this.mc!;
    lc.restore();
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.clearRect(0, 0, w, h);
    mc.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
    mc.globalAlpha = 1;
    mc.globalCompositeOperation = "source-over";
    mc.fillStyle = "#000";
    mc.fill(aperture);
    mc.globalCompositeOperation = "destination-out";
    mc.strokeStyle = "#000";
    mc.lineJoin = "round";
    mc.lineCap = "round";
    if (this.filters) {
      mc.lineWidth = 2 * MASK_ERODE * feather;
      mc.stroke(aperture);
      // Blurred in place: the mask drawn over itself (a snapshot is taken
      // first) through the filter, replacing what was there.
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.globalCompositeOperation = "copy";
      mc.filter = `blur(${(MASK_SIGMA * feather * this.scale).toFixed(2)}px)`;
      mc.drawImage(this.mask!, 0, 0, w, h, 0, 0, w, h);
      mc.filter = "none";
      mc.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - x, matrix.f - y);
    } else {
      for (const step of featherSteps(feather)) {
        mc.lineWidth = step.lineWidth;
        mc.globalAlpha = step.alpha;
        mc.stroke(aperture);
      }
      mc.globalAlpha = 1;
    }
    mc.globalCompositeOperation = "source-over";
    if (corners && corners.reach > 0) {
      for (const c of corners.points) {
        // Clipped to the stamp's own box: the gradient is nothing past its
        // reach, and filling the whole aperture through it cost as much as
        // the blur.
        const r = corners.reach;
        mc.save();
        mc.beginPath();
        mc.rect(c.x - r, c.y - r, 2 * r, 2 * r);
        mc.clip();
        const stamp = mc.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        for (const [t, a] of CORNER_STOPS) stamp.addColorStop(t, `rgba(0,0,0,${a.toFixed(3)})`);
        mc.fillStyle = stamp;
        mc.fill(aperture);
        mc.restore();
      }
    }
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = "destination-in";
    lc.drawImage(this.mask!, 0, 0, w, h, 0, 0, w, h);
    lc.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.layer!, 0, 0, w, h, x, y, w, h);
    ctx.restore();
  }
}
