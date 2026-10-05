import type { MouthPoint } from "../mouth-extension";
import type { BlendWeights } from "../types";

/** Back opening of a shallow inner-lip tunnel. The front opening is the
 * measured, already-deformed lip ring. Only visibility changes: the dental
 * arches themselves are never scaled, dissolved or moved by rounding.
 * This is a frontal 2D depth approximation, not reconstructed lip anatomy. */
export function dentalOpening(
  ring: readonly MouthPoint[], left: MouthPoint, right: MouthPoint, weights: BlendWeights,
): MouthPoint[] {
  if (!ring.length) return [];
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 1e-6) return ring.map(p => ({ ...p }));
  const ux = (right.x - left.x) / width, uy = (right.y - left.y) / width;
  const local = ring.map(p => ({ x: (p.x - left.x) * ux + (p.y - left.y) * uy,
    y: -(p.x - left.x) * uy + (p.y - left.y) * ux }));
  const cx = (Math.min(...local.map(p => p.x)) + Math.max(...local.map(p => p.x))) / 2;
  const top = Math.min(...local.map(p => p.y)), bottom = Math.max(...local.map(p => p.y));
  const height = bottom - top;
  const rounding = Math.max(0, Math.min(1, weights.mouthPucker + weights.mouthFunnel * .6));
  // The lower lip rolls inward farther than the upper lip during rounding.
  // A symmetric shrink exposes the lower crowns through OO. Bound total
  // depth by the actual opening so narrow/closed lips cannot invert the mask.
  // In a strong pucker the front opening remains visible, but the back
  // opening can close completely over the recessed dental plane.
  const depth = Math.min(width * .15 * rounding, height);
  return local.map(p => {
    const x = cx + (p.x - cx) * (1 - .14 * rounding);
    const v = height > 1e-6 ? (p.y - top) / height : .5;
    const y = p.y + depth * (1 / 6 - v);
    return { x: left.x + x * ux - y * uy, y: left.y + x * uy + y * ux };
  });
}

const smooth = (t: number) => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/**
 * Where the teeth start to show between parting lips, and where they are
 * fully there, as shares of the mouth's width.
 *
 * Found on three real avatars: between words the lips settle 0.02 to 0.06
 * of a mouth apart, and the upper teeth drawn through that aperture at full
 * strength were a bright white line between the lips, a glint or a false
 * tooth line, worst on dark lips. Lips that are only just apart show the
 * dark of the mouth, not enamel; the teeth come into the light as the gap
 * grows. Tuned by eye on a soft scan, a render and a warm photo.
 */
export const ENAMEL_REVEAL: readonly [number, number] = [0.03, 0.09];

/** How much of the teeth shows at a lip gap of `gap` on a mouth `width`
 *  wide: 0 up to ENAMEL_REVEAL[0], 1 from ENAMEL_REVEAL[1], smooth between.
 *  At a closed mouth (the Reference's authored rest) it is exactly 0. */
export function enamelReveal(gap: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(gap)) return 0;
  const [from, to] = ENAMEL_REVEAL;
  return smooth((gap / width - from) / (to - from));
}

/** Where the mouth's dark interior starts to show and where it is whole,
 *  as shares of the mouth's width: the classic mouth's own ramp (its cavity
 *  comes in over 0.03 to 0.07). Below it the lips' own stretched seam shows,
 *  under the contact line; painted whole from the first pixel of gap, the
 *  interior was a hard-edged dark slot cut into the lips. */
export const CAVITY_REVEAL: readonly [number, number] = [0.025, 0.07];

/** How much of the mouth's interior shows at a lip gap of `gap`: 0 up to
 *  CAVITY_REVEAL[0], 1 from CAVITY_REVEAL[1], smooth between, and always at
 *  least the enamel's own reveal, so the teeth never float on the lips. */
export function cavityReveal(gap: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(gap)) return 0;
  const [from, to] = CAVITY_REVEAL;
  return Math.max(enamelReveal(gap, width), smooth((gap / width - from) / (to - from)));
}

/**
 * The strength of the soft dark line where the lips meet, 0 to 1: the lips'
 * own shadow, filling the small apertures the teeth are not yet in. It
 * comes in as the lips first part (so there is no line painted on a closed
 * mouth that had none) and goes as the teeth arrive, crossing over with the
 * cavity's own reveal so the seam is never both absent and toothless.
 */
export function contactSeam(gap: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(gap)) return 0;
  const g = gap / width;
  return smooth((g - 0.008) / 0.012) * (1 - smooth((g - 0.05) / 0.06));
}

/**
 * A reveal rises from nothing to whole over no less than this many ms.
 *
 * The ramps above are over the gap, and a mouth opening after a closure
 * crosses the whole enamel ramp (0.03 to 0.09 of the width) in a single
 * frame at 60 fps: the teeth popped on, whole, in one frame, eleven times
 * in the production sentence. Over 60 ms (four frames) they come into the
 * light as the lips part. Falls are not slowed: what closing lips cover is
 * covered, and a slit holding yesterday's enamel would be the white line
 * between the lips this model exists to prevent.
 */
export const REVEAL_RISE_MS = 60;

/**
 * A reveal's alpha followed over time: it falls as fast as the lips close
 * and rises over at least REVEAL_RISE_MS. The first value is taken whole:
 * a first frame is not a transition, so a single rendered frame (a golden,
 * a held pose) is what the ramps over the gap say.
 */
export class RevealRamp {
  private value = Number.NaN;
  step(target: number, dtMs: number): number {
    if (!Number.isFinite(this.value) || target <= this.value) {
      this.value = target;
      return target;
    }
    this.value = Math.min(target, this.value + Math.max(0, dtMs) / REVEAL_RISE_MS);
    return this.value;
  }
}

export function openingPath(points: readonly MouthPoint[]): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => { if (!i) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y); });
  path.closePath();
  return path;
}
