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

export function openingPath(points: readonly MouthPoint[]): Path2D {
  const path = new Path2D();
  points.forEach((p, i) => { if (!i) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y); });
  path.closePath();
  return path;
}
