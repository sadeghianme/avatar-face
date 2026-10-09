/**
 * The head's turn as the camera sees it: a point of the face at its depth
 * (head-depth.ts), turned by the head's yaw, pitch and roll about the pivot
 * between the ears, and projected back through a mild perspective. The
 * turn in depth (head-turn.ts) moves every landmark through it, the head's
 * field (head-field-turn.ts) its own vertices, and the head's rigid motion
 * follows the skull point through it (HeadTurn.skullShift).
 */
import type { Point } from "./geometry";

/** The head's rotation, radians: yaw + turns the nose to the canvas's
 *  right, pitch + nods it down, roll + tilts the crown clockwise. */
export interface HeadPose3D {
  yaw: number;
  pitch: number;
  roll: number;
}

/** The camera's distance from the pivot, in inter-ocular distances: about
 *  60 cm for a 6.3 cm adult IOD, a portrait lens. */
export const CAMERA_IOD = 9;

/**
 * (x, y) on the canvas at depth z (canvas px, + toward the camera), turned
 * by `pose` about `pivot` and seen again through a camera `distance` px in
 * front of it. Written into `out`, which is returned: the turn projects
 * every landmark every frame, and makes no point to do it.
 */
export function projectTurn(
  out: Point,
  x: number,
  y: number,
  z: number,
  pose: HeadPose3D,
  pivot: { readonly x: number; readonly y: number; readonly z: number },
  distance: number
): Point {
  const P = pivot,
    D = distance;
  // Back out of the perspective the photo was taken through.
  const Z = z - P.z;
  const k0 = (D - Z) / D;
  let X = (x - P.x) * k0,
    Y = (y - P.y) * k0,
    W = Z;
  // Yaw about the vertical, pitch about the horizontal, roll in the
  // picture plane (y is down, z toward the camera).
  const cy = Math.cos(pose.yaw),
    sy = Math.sin(pose.yaw);
  let t = X * cy + W * sy;
  W = -X * sy + W * cy;
  X = t;
  const cp = Math.cos(pose.pitch),
    sp = Math.sin(pose.pitch);
  t = Y * cp + W * sp;
  W = -Y * sp + W * cp;
  Y = t;
  const cr = Math.cos(pose.roll),
    sr = Math.sin(pose.roll);
  t = X * cr - Y * sr;
  Y = X * sr + Y * cr;
  X = t;
  const k = D / (D - W);
  out.x = P.x + X * k;
  out.y = P.y + Y * k;
  return out;
}
