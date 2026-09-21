import type { BlendWeights, Rig } from "./types";

export interface MouthPoint { x: number; y: number }
export interface MouthPose { viseme: string; weights: BlendWeights }

/** Seat oral geometry on the central seam, including a bowed or tilted lip. */
export function centralMouthAnchors(ring: readonly MouthPoint[], a: MouthPoint, b: MouthPoint): [MouthPoint, MouthPoint] {
  const left = a.x <= b.x ? a : b, right = a.x <= b.x ? b : a;
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 1e-6 || !ring.length) return [{ ...left }, { ...right }];
  const ux = (right.x - left.x) / width, uy = (right.y - left.y) / width;
  const cx = (left.x + right.x) / 2, cy = (left.y + right.y) / 2;
  const central = [...ring].sort((p, q) =>
    Math.abs((p.x - cx) * ux + (p.y - cy) * uy) - Math.abs((q.x - cx) * ux + (q.y - cy) * uy)).slice(0, 2);
  const bow = central.reduce((sum, p) => sum - (p.x - cx) * uy + (p.y - cy) * ux, 0) / central.length;
  return [left, right].map(p => ({ x: p.x - uy * bow, y: p.y + ux * bow })) as [MouthPoint, MouthPoint];
}

/** Optional rendering seam. The production engine never imports a lab module. */
export interface MouthExtension {
  deform?(points: MouthPoint[], neutral: readonly MouthPoint[], rig: Rig, weights: BlendWeights): void;
  /** Optional photographic lip/skin pass. Return true when it owns the entire
   * mouth, including the contact line and interior (also at closed rest). */
  paint?(ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame): boolean;
  draw(ctx: CanvasRenderingContext2D, frame: MouthFrame): void;
}

export interface MouthSurfaceFrame {
  lipColour?: [number, number, number];
  points: readonly MouthPoint[];
  neutral: readonly MouthPoint[];
  rig: Rig;
  weights: BlendWeights;
  viseme: string;
}

export interface MouthFrame {
  weights: BlendWeights;
  viseme: string;
  upper: MouthPoint[];
  lower: MouthPoint[];
  aperture: Path2D;
  neutralLeft: MouthPoint;
  neutralRight: MouthPoint;
  lipColour: [number, number, number];
  cavityAlpha: number;
  teethAlpha: number;
}
