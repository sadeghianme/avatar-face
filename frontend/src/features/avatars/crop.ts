/**
 * The crop rectangle's geometry (CropBox draws it): moving it, resizing it
 * from a handle or with the keys, and holding it to an aspect. Pure, so
 * `npm test` covers it without a browser.
 *
 * Every rectangle is in fractions of the image, so it survives any display
 * size; an aspect is in pixels, so it goes through the image's own size.
 */

/** Fractions of the image, so the rectangle survives any display size. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** A gesture in progress: the rectangle moved by where it was grabbed, or
 *  resized from one handle; both from the rectangle as it was at the press. */
export type CropDrag =
  | { kind: "move"; grabX: number; grabY: number; start: CropRect }
  | { kind: "resize"; handle: CropHandle; start: CropRect };

/** Matches the server, which refuses to leave a face with nothing on it. */
export const MIN_SIDE = 0.15;
// One arrow key press moves or resizes the rectangle by this share of the
// image. There is no fast variant: Shift already means resize, and 1% is
// fine enough for a crop and quick enough to cross a photo.
export const KEY_STEP = 0.01;
// A keyboard resize stops here; the pointer can go smaller and is told off
// by the red outline, but a held key would otherwise collapse the box.
export const KEY_MIN_SIDE = 0.05;
export const DEFAULT_RECT: CropRect = { x: 0.08, y: 0.04, w: 0.84, h: 0.92 };

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Smaller than the server allows, on either side. */
export const tooSmall = (r: CropRect) => r.w < MIN_SIDE || r.h < MIN_SIDE;

/** The rectangle in image pixels, "w × h"; empty before the image's size is known. */
export function pixelSize(r: CropRect, natural: Size | null): string {
  return natural ? `${Math.round(r.w * natural.w)} × ${Math.round(r.h * natural.h)}` : "";
}

/**
 * Force a rectangle to a locked aspect (width over height, in pixels),
 * holding the given anchor still. No aspect, or no image size yet: as is.
 */
export function withRatio(
  r: CropRect,
  ratio: number | null,
  natural: Size | null,
  anchorRight: boolean,
  anchorBottom: boolean
): CropRect {
  if (!ratio || !natural) return r;
  // The rectangle is in fractions of two different dimensions, so the pixel
  // aspect is not w/h — it has to go through the image's own proportions.
  const h = (r.w * natural.w) / (ratio * natural.h);
  const next = { ...r, h };
  if (anchorBottom) next.y = r.y + r.h - h;
  if (next.y < 0) next.y = 0;
  if (next.y + next.h > 1) next.h = 1 - next.y;
  if (anchorRight) next.x = r.x + r.w - next.w;
  return next;
}

/** A newly chosen aspect applied to the rectangle: its width kept, its height made to match. */
export function fitRatio(r: CropRect, ratio: number | null, natural: Size | null): CropRect {
  if (!ratio || !natural) return r;
  const h = (r.w * natural.w) / (ratio * natural.h);
  const y = Math.max(0, Math.min(1 - Math.min(h, 1), r.y));
  return { ...r, y, h: Math.min(h, 1 - y) };
}

/** Where a drag puts the rectangle with the pointer at `p` (fractions of the image). */
export function dragTo(
  drag: CropDrag,
  p: { x: number; y: number },
  ratio: number | null,
  natural: Size | null
): CropRect {
  const s = drag.start;
  if (drag.kind === "move") {
    return {
      ...s,
      // Clamped so the box slides along the edge rather than shrinking when
      // it is pushed past the boundary.
      x: Math.max(0, Math.min(1 - s.w, s.x + (p.x - drag.grabX))),
      y: Math.max(0, Math.min(1 - s.h, s.y + (p.y - drag.grabY))),
    };
  }
  const h = drag.handle;
  const west = h === "nw" || h === "w" || h === "sw";
  const east = h === "ne" || h === "e" || h === "se";
  const north = h === "nw" || h === "n" || h === "ne";
  const south = h === "sw" || h === "s" || h === "se";

  let x0 = west ? p.x : s.x;
  let x1 = east ? p.x : s.x + s.w;
  let y0 = north ? p.y : s.y;
  let y1 = south ? p.y : s.y + s.h;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];

  return withRatio({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, ratio, natural, east, south);
}

/**
 * An arrow key on the rectangle: moved by one step, or with Shift resized
 * from its right and bottom edges. Null for any other key.
 */
export function keyed(
  r: CropRect,
  key: string,
  shift: boolean,
  ratio: number | null,
  natural: Size | null
): CropRect | null {
  const dx = key === "ArrowLeft" ? -KEY_STEP : key === "ArrowRight" ? KEY_STEP : 0;
  const dy = key === "ArrowUp" ? -KEY_STEP : key === "ArrowDown" ? KEY_STEP : 0;
  if (!dx && !dy) return null;
  if (shift) {
    const w = Math.max(KEY_MIN_SIDE, Math.min(1 - r.x, r.w + dx));
    const h = Math.max(KEY_MIN_SIDE, Math.min(1 - r.y, r.h + dy));
    return withRatio({ ...r, w, h }, ratio, natural, false, false);
  }
  return {
    ...r,
    x: Math.max(0, Math.min(1 - r.w, r.x + dx)),
    y: Math.max(0, Math.min(1 - r.h, r.y + dy)),
  };
}
