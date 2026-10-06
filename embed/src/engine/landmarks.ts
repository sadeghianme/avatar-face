/**
 * The MediaPipe face-mesh landmarks the engine reads by index: the brows,
 * the lids, the eye corners, the irises and the cheeks. One table, so the
 * deformation, the texture sampling and the painters agree on what "the
 * upper lid" is.
 */
import type { Point } from "./geometry";

/** The face mesh's own landmarks; the engine's derived vertices (the mouth
 *  subdivision's midpoints, the neck band) are numbered from here. */
export const LANDMARK_COUNT = 478;

// Canonical MediaPipe brow rows, inner -> outer.
export const LEFT_BROW = [55, 65, 52, 53, 46];
export const RIGHT_BROW = [285, 295, 282, 283, 276];

// Eyes split into lids: a blink is the UPPER lid sweeping down over the
// eyeball (skin from above stretches down to cover it) — NOT the whole ring
// squashing, which compresses the eyeball texture and looks alien.
export const UPPER_LIDS = [
  [246, 161, 160, 159, 158, 157, 173],
  [466, 388, 387, 386, 385, 384, 398],
];
export const LOWER_LIDS = [
  [7, 163, 144, 145, 153, 154, 155],
  [249, 390, 373, 374, 380, 381, 382],
];
export const EYE_CORNERS: [number, number][] = [
  [33, 133],
  [263, 362],
];

// The second eye detector: MediaPipe's iris ring — a center plus four rim
// points per eye. Gives the pupil's position and radius directly, so the
// gaze shift can be confined to a circle around the iris instead of the
// whole eye opening.
export const IRISES: [number, number[]][] = [
  [468, [469, 470, 471, 472]],
  [473, [474, 475, 476, 477]],
];

// Mid-cheek, both sides: clear of beard, brow shadow, nose highlight.
export const CHEEK_LANDMARKS = [50, 280, 205, 425, 101, 330];

/** An eye's two lids as ordered point lists, corner to corner. */
export function eyeShape(pts: readonly Point[], e: number): { upper: Point[]; lower: Point[] } {
  const [c0, c1] = EYE_CORNERS[e];
  const byX = (a: Point, b: Point) => a.x - b.x;
  const upper = [pts[c0], ...UPPER_LIDS[e].map((i) => pts[i]), pts[c1]].sort(byX);
  const lower = [pts[c0], ...LOWER_LIDS[e].map((i) => pts[i]), pts[c1]].sort(byX);
  return { upper, lower };
}
