/** Framing: the crop and the roll (see index.ts). */
import { stepById } from "./images.ts";
import type { Creation, CropRect } from "./types.ts";

export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** The API's bounds on a roll (degrees). */
export const MAX_ROLL = 45;

export interface Framing {
  crop: CropRect;
  roll: number;
}

/** The framing the creation has now: its framed step's, or the whole photo. */
export function appliedFraming(creation: Creation): Framing {
  const framed = stepById(creation, "framed");
  return {
    crop: framed?.crop ?? FULL_FRAME,
    roll: framed?.roll ?? 0,
  };
}

/**
 * The framing step 1 opens with. What was applied, when something was;
 * the analysis' suggestion on a photo nobody has touched since ingest
 * (revision 1: ingest's own write); the whole photo after that, since a
 * creation that moved on unframed was left that way on purpose.
 */
export function initialFraming(creation: Creation): Framing {
  if (stepById(creation, "framed")) return appliedFraming(creation);
  const untouched = creation.revision <= 1 && !creation.anchors && !stepById(creation, "cutout");
  const suggested = creation.analysis?.suggested_framing;
  if (untouched && suggested) return { crop: suggested.crop, roll: suggested.roll };
  return { crop: FULL_FRAME, roll: 0 };
}

// Crops round-trip through the server at 4 decimals; a difference below
// this is the same crop, and re-sending it would drop the cut-out and marks.
const CROP_EPSILON = 5e-4;
const ROLL_EPSILON = 0.05;

export function framingChanged(a: Framing, b: Framing): boolean {
  const keys: (keyof CropRect)[] = ["x", "y", "w", "h"];
  return keys.some((k) => Math.abs(a.crop[k] - b.crop[k]) > CROP_EPSILON) || Math.abs(a.roll - b.roll) > ROLL_EPSILON;
}

/**
 * A crop as the API takes it: 4 decimals (what it stores), inside the
 * photo after rounding. A box dragged to the edge can round to x + w of
 * 1.0001, which the server refuses as out of bounds.
 */
export function normalizeCrop(crop: CropRect): CropRect {
  const round = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
  const x = round(crop.x);
  const y = round(crop.y);
  return { x, y, w: Math.min(round(crop.w), round(1 - x)), h: Math.min(round(crop.h), round(1 - y)) };
}

export function clampRoll(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return Math.max(-MAX_ROLL, Math.min(MAX_ROLL, Math.round(degrees * 10) / 10));
}
