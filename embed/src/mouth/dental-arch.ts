/**
 * The dental arches in depth, for a head that turns in depth (MouthTurn,
 * mouth-extension.ts): where the teeth photo's arches are seen when the
 * head is not facing the camera, and how an arch is drawn there
 * (drawTurnedArch, for dental-oral-surface.ts).
 *
 * Facing the camera, an arch is its picture's `box` drawn on a rectangle
 * of the mouth's frame (dental-texture-model.ts dentalPlacement): the
 * photo is the arch seen from in front, so each of its columns is the
 * arch's surface at that distance off the midline. Turned, each column is
 * given that surface's depth behind the lips (ARCH_MM) and seen through the
 * turn (MouthTurn.behindLips): the whole arch, deeper than the lips, turns
 * with them a little less, and since it curves back toward the molars, the
 * side coming toward the camera widens and the far side foreshortens.
 *
 * The turn is split in two (TurnedArch):
 *  - `frame`: the rectangle taken onto the box the turned arch spans (a
 *    scale and a shift), drawn through the context's transform;
 *  - the bend left inside it, applied to the arch's picture in its own
 *    pixels: ARCH_STRIPS strips along its width, each an affine piece,
 *    each drawn in a band of whole pixels (the bands tile the picture, so
 *    every pixel is drawn once and no seam can open). The frame spans the
 *    turned arch, so the bent arch stays inside its box.
 * The bent picture's box is then drawn on the rectangle exactly as the
 * frontal arch is (the same box, rectangle, clip, alpha and filter),
 * through `frame`. With no turn the frame and every strip are the identity
 * and the drawing is the frontal one, pixel for pixel; as the turn grows
 * from nothing the transform and the picture move continuously from there.
 * (A window over the picture that grew with the turn would not: Skia draws
 * a whole-pixel source rectangle's edges unlike a fractional one's.)
 */
import { apply, invert, type Affine } from "../engine/affine";
import type { MouthPoint, MouthTurn } from "../mouth-extension";

/**
 * The arches' depth behind the lips' line, mm of the face: the upper
 * incisors' faces `upper` behind it, the lower's `lower` (behind the upper:
 * the overjet), and each arch curving back toward the molars as a parabola,
 * `curve` mm back per mm² off the midline (the canines, 17 mm out, 9 mm
 * further back; the first molars, 25 mm out, 19 mm). Adult averages.
 */
export const ARCH_MM = { upper: 10, lower: 12, curve: 0.031 } as const;

/** The strips an arch is laid in along its width, each an affine piece: at
 *  the personality's 9 degrees, on a mouth 200 px wide, a strip strays
 *  from the arch's curve by under 0.05 px. */
export const ARCH_STRIPS = 24;

/** How far behind the lips' line an arch's surface lies, `off` mm off the
 *  midline (either side), mm. */
export function archDepthMm(lower: boolean, off: number): number {
  return (lower ? ARCH_MM.lower : ARCH_MM.upper) + ARCH_MM.curve * off * off;
}

/**
 * The mouth's frame a mouth is drawn in, canvas px: the centre between its
 * anchors, the unit axis from left to right, and the width. Its local units
 * are widths: x along the axis, y across it (down for an upright mouth), as
 * `ctx.translate(cx, cy); ctx.rotate(angle); ctx.scale(width, width)` lays
 * them.
 */
export interface MouthAxis {
  cx: number;
  cy: number;
  width: number;
  cos: number;
  sin: number;
}

/** The frame of the mouth whose anchors are `left` and `right`, into `out`. */
export function mouthAxis(
  left: MouthPoint,
  right: MouthPoint,
  out: MouthAxis = { cx: 0, cy: 0, width: 1, cos: 1, sin: 0 }
): MouthAxis {
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  out.cx = (left.x + right.x) / 2;
  out.cy = (left.y + right.y) / 2;
  out.width = Math.hypot(right.x - left.x, right.y - left.y);
  out.cos = Math.cos(angle);
  out.sin = Math.sin(angle);
  return out;
}

/** A rectangle: of the mouth's local units (dentalPlacement's), or of a
 *  picture's pixels (an arch's box). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the turn shows the point (x, y) of the mouth's local units lying
 * `depthMm` behind the lips, in local units, into `out`.
 */
export function turnedLocal(
  axis: MouthAxis,
  turn: MouthTurn,
  x: number,
  y: number,
  depthMm: number,
  out: MouthPoint
): MouthPoint {
  const { cx, cy, width, cos, sin } = axis;
  turn.behindLips(out, cx + width * (x * cos - y * sin), cy + width * (x * sin + y * cos), depthMm * turn.mm);
  const dx = (out.x - cx) / width,
    dy = (out.y - cy) / width;
  out.x = dx * cos + dy * sin;
  out.y = -dx * sin + dy * cos;
  return out;
}

/**
 * One arch as a turn shows it: the picture's `box` drawn facing the camera
 * on `rect` (local units), turned, split into its frame and its bend
 * (drawTurnedArch). Rewritten by each lay; one per arch, kept frame to
 * frame.
 */
export class TurnedArch {
  /** The rectangle onto the box the turned arch spans, local units, as
   *  ctx.transform takes it. The identity at no turn. */
  readonly frame: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  /** Per strip, the bend: the affine (a, b, c, d, e, f, picture px) that
   *  takes the picture to the bent picture there. The identity at no turn. */
  readonly strips = new Float64Array(6 * ARCH_STRIPS);
  /** Per strip edge (ARCH_STRIPS + 1), where the bands are cut, picture px:
   *  the first at 0, the last at the picture's width, the others at the
   *  strip edges' middles, bent and rounded; none running backwards. */
  readonly edges = new Float64Array(ARCH_STRIPS + 1);
  /** Per strip edge, the arch's top and bottom rows: turned (local units),
   *  then bent (picture px). */
  private readonly top = new Float64Array(2 * (ARCH_STRIPS + 1));
  private readonly bottom = new Float64Array(2 * (ARCH_STRIPS + 1));
  private readonly unframe: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  private readonly seen: MouthPoint = { x: 0, y: 0 };

  /**
   * The arch whose picture (`width` px wide) has its `box` drawn on `rect`
   * of the mouth `axis`, the upper or the `lower`, turned by `turn`.
   */
  lay(width: number, box: Rect, rect: Rect, axis: MouthAxis, lower: boolean, turn: MouthTurn): this {
    const n = ARCH_STRIPS;
    const { top, bottom, seen } = this;
    for (let k = 0; k <= n; k++) {
      const x = rect.x + (rect.width * k) / n;
      // Local x is in widths from the mouth's centre: the arch's midline,
      // where the photo's lips met.
      const depth = archDepthMm(lower, (x * axis.width) / turn.mm);
      turnedLocal(axis, turn, x, rect.y, depth, seen);
      top[2 * k] = seen.x;
      top[2 * k + 1] = seen.y;
      turnedLocal(axis, turn, x, rect.y + rect.height, depth, seen);
      bottom[2 * k] = seen.x;
      bottom[2 * k + 1] = seen.y;
    }
    this.fitFrame(rect);
    this.bend(box, rect);
    this.fitStrips(box);
    this.cutBands(width);
    return this;
  }

  /** The frame: the rectangle onto the box the turned arch spans (its rows'
   *  extremes along the mouth and across it), so the bend leaves it inside
   *  the rectangle; continuous in the turn, the identity at none. */
  private fitFrame(rect: Rect): void {
    const { top, bottom, frame } = this;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i <= ARCH_STRIPS; i++) {
      x0 = Math.min(x0, top[2 * i], bottom[2 * i]);
      x1 = Math.max(x1, top[2 * i], bottom[2 * i]);
      y0 = Math.min(y0, top[2 * i + 1], bottom[2 * i + 1]);
      y1 = Math.max(y1, top[2 * i + 1], bottom[2 * i + 1]);
    }
    frame.a = (x1 - x0) / rect.width;
    frame.d = (y1 - y0) / rect.height;
    frame.b = frame.c = 0;
    frame.e = x0 - frame.a * rect.x;
    frame.f = y0 - frame.d * rect.y;
    invert(frame, this.unframe);
  }

  /** The turned rows with the frame taken out, in the picture's px, as the
   *  frontal drawing maps local units to them. */
  private bend(box: Rect, rect: Rect): void {
    const { unframe, seen } = this;
    for (let i = 0; i < 2 * (ARCH_STRIPS + 1); i++) {
      const row = i % 2 ? this.bottom : this.top,
        k = i >> 1;
      seen.x = row[2 * k];
      seen.y = row[2 * k + 1];
      apply(unframe, seen, seen);
      row[2 * k] = box.x + ((seen.x - rect.x) * box.width) / rect.width;
      row[2 * k + 1] = box.y + ((seen.y - rect.y) * box.height) / rect.height;
    }
  }

  /** Each strip's affine: its top edge and left side, as the picture has
   *  them and bent. */
  private fitStrips(box: Rect): void {
    const { top, bottom, strips } = this;
    const v0 = box.y,
      h = box.height;
    for (let k = 0; k < ARCH_STRIPS; k++) {
      const u = column(box, k),
        w = column(box, k + 1) - u;
      const a = (top[2 * k + 2] - top[2 * k]) / w,
        b = (top[2 * k + 3] - top[2 * k + 1]) / w,
        c = (bottom[2 * k] - top[2 * k]) / h,
        d = (bottom[2 * k + 1] - top[2 * k + 1]) / h;
      const s = 6 * k;
      strips[s] = a;
      strips[s + 1] = b;
      strips[s + 2] = c;
      strips[s + 3] = d;
      strips[s + 4] = top[2 * k] - a * u - c * v0;
      strips[s + 5] = top[2 * k + 1] - b * u - d * v0;
    }
  }

  /** The bands: cut at each inner strip edge's middle, bent, rounded to a
   *  pixel; never backwards (an arch turned past folding would). */
  private cutBands(width: number): void {
    const { top, bottom, edges } = this;
    edges[0] = 0;
    edges[ARCH_STRIPS] = width;
    for (let k = 1; k < ARCH_STRIPS; k++) {
      const middle = Math.round((top[2 * k] + bottom[2 * k]) / 2);
      edges[k] = Math.min(width, Math.max(edges[k - 1], middle));
    }
  }
}

/** Strip edge `k`'s column of `box`, picture px. */
function column(box: Rect, k: number): number {
  return box.x + (box.width * k) / ARCH_STRIPS;
}

/**
 * `box` of `source` drawn on `rect` (the mouth's local units, `ctx`'s
 * current frame) as `arch` (laid for them) shows it: the picture bent onto
 * `bent` (a canvas kept for it, resized to the picture), band by band, and
 * its box drawn on the rectangle through the arch's frame, under whatever
 * transform, clip, alpha and filter `ctx` has. With no turn, exactly
 * `ctx.drawImage(source, box, rect)`.
 */
export function drawTurnedArch(
  ctx: CanvasRenderingContext2D,
  arch: TurnedArch,
  source: HTMLCanvasElement,
  box: Rect,
  rect: Rect,
  bent: HTMLCanvasElement
): void {
  const { width, height } = source;
  if (bent.width !== width || bent.height !== height) {
    bent.width = width;
    bent.height = height;
  }
  const b = bent.getContext("2d");
  if (!b) return;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, width, height);
  const s = arch.strips,
    edges = arch.edges;
  for (let k = 0; k < ARCH_STRIPS; k++) {
    if (edges[k + 1] <= edges[k]) continue;
    b.save();
    // The band on whole pixels: a clip with no edge to antialias.
    b.beginPath();
    b.rect(edges[k], 0, edges[k + 1] - edges[k], height);
    b.clip();
    b.setTransform(s[6 * k], s[6 * k + 1], s[6 * k + 2], s[6 * k + 3], s[6 * k + 4], s[6 * k + 5]);
    b.drawImage(source, 0, 0);
    b.restore();
  }
  const f = arch.frame;
  ctx.save();
  ctx.transform(f.a, f.b, f.c, f.d, f.e, f.f);
  ctx.drawImage(bent, box.x, box.y, box.width, box.height, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}
