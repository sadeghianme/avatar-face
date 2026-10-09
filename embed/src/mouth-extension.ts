import type { BlendWeights, Rig } from "./types";

export interface MouthPoint {
  x: number;
  y: number;
}
export interface MouthPose {
  viseme: string;
  weights: BlendWeights;
}

/** Seat oral geometry on the central seam, including a bowed or tilted lip. */
export function centralMouthAnchors(
  ring: readonly MouthPoint[],
  a: MouthPoint,
  b: MouthPoint
): [MouthPoint, MouthPoint] {
  const left = a.x <= b.x ? a : b,
    right = a.x <= b.x ? b : a;
  const width = Math.hypot(right.x - left.x, right.y - left.y);
  if (width < 1e-6 || !ring.length) return [{ ...left }, { ...right }];
  const ux = (right.x - left.x) / width,
    uy = (right.y - left.y) / width;
  const cx = (left.x + right.x) / 2,
    cy = (left.y + right.y) / 2;
  const central = [...ring]
    .sort((p, q) => Math.abs((p.x - cx) * ux + (p.y - cy) * uy) - Math.abs((q.x - cx) * ux + (q.y - cy) * uy))
    .slice(0, 2);
  const bow = central.reduce((sum, p) => sum - (p.x - cx) * uy + (p.y - cy) * ux, 0) / central.length;
  return [left, right].map((p) => ({ x: p.x - uy * bow, y: p.y + ux * bow })) as [MouthPoint, MouthPoint];
}

/**
 * Optional rendering seam. The production engine never imports a lab module.
 *
 * What the engine hands an extension is valid for the call it is handed
 * in, that frame, and no longer: the engine keeps one set of vertices and
 * moves them again every frame (engine/deform.ts FrameVertices), so the
 * `points` given to `deform`, the frame given to `paint` (its `points`
 * above all) and the frame given to `draw` are the engine's own, about to
 * change. An extension that needs any of it in a later frame copies the
 * numbers it needs; it never keeps the arrays or the points. `deform`
 * moves `points` in place, the face's landmarks only (478 of them); the
 * others read what they are given and change none of it.
 */
export interface MouthExtension {
  deform?(points: MouthPoint[], neutral: readonly MouthPoint[], rig: Rig, weights: BlendWeights): void;
  /** Optional photographic lip/skin pass. Return true when it owns the entire
   * mouth, including the contact line and interior (also at closed rest). */
  paint?(ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame): boolean;
  draw(ctx: CanvasRenderingContext2D, frame: MouthFrame): void;
}

export interface MouthSurfaceFrame {
  lipColour?: [number, number, number];
  /** Mid-cheek skin: the scene's exposure and cast. Absent on a tainted texture. */
  skinColour?: [number, number, number];
  /** Luma (0-255) of the picture's brightest skin or sclera (face-light.ts):
   *  the ceiling for anything drawn into it. Absent on a tainted texture. */
  faceHighlight?: number;
  /** How soft the picture's own edges are, as a share of the mouth's width
   *  (CharacterLook.soft: the picture's sharpness over the mouth's width,
   *  the lip seam's step when there is none). The photographic mouth reads
   *  `sharpness` and `pixelScale` below instead. */
  soft?: number;
  /** The width of the picture's crispest edges, in texture pixels
   *  (face-sharpness.ts), and how many of this frame's pixels one texture
   *  pixel is: their product is the picture's sharpness in the frame.
   *  Absent on a flat or tainted picture. */
  sharpness?: number;
  pixelScale?: number;
  /** Every vertex of the mesh this frame, canvas px: the engine's own,
   *  moved again next frame (MouthExtension). */
  points: readonly MouthPoint[];
  /** The face's landmarks at rest, no speech in them, as this frame shows
   *  them: the mouth's frame (its corners, centre, width and angle are read
   *  off these). The rest pose itself, unless the head turns in depth this
   *  frame: then the rest pose moved as the turn moved each landmark, the
   *  lips as one piece, so what is placed from it sits where the turned
   *  lips in `points` are (engine/mouth-pose.ts). */
  neutral: readonly MouthPoint[];
  /** The head's turn in depth this frame (the "3d" head motion), for what
   *  lies behind the lips; absent when the face did not turn in depth (at
   *  rest, in the "2d" motion). Optional to read: an extension that
   *  ignores it draws everything in `neutral`'s frame, as on the lips. */
  turn?: MouthTurn;
  rig: Rig;
  weights: BlendWeights;
  viseme: string;
}

/**
 * The head's turn in depth, for what a mouth draws behind the lips
 * (MouthSurfaceFrame.turn). The lips turn as one piece with the face;
 * what lies deeper, the teeth, turns about the same pivot, so it moves a
 * little less than they do (parallax), as a solid head's does. Valid for
 * the frame it is handed in, as the rest of the frame is.
 */
export interface MouthTurn {
  /** This frame's yaw and pitch, radians, as far as the face turned: yaw
   *  + turns the nose to the canvas's right, pitch + nods it down. */
  readonly yaw: number;
  readonly pitch: number;
  /** Canvas px per millimetre of this face. */
  readonly mm: number;
  /**
   * Where a point `depth` px behind the lips' surface is seen this frame,
   * written into `out` and returned. (x, y) is the point as if it lay on
   * the lips, in `neutral`'s frame: at depth 0 it is (x, y) itself, and
   * so is any depth while the head faces the camera. Continuous in the
   * turn and the depth.
   */
  behindLips(out: MouthPoint, x: number, y: number, depth: number): MouthPoint;
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
  skinColour?: [number, number, number];
  cavityAlpha: number;
  teethAlpha: number;
}
