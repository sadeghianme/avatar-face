/**
 * The marking canvas's magnifier, as geometry: how big it is, which corner
 * of the photo it sits in, and which part of the photo it shows. Pure, so
 * it is tested with `node --test` and the component only paints it.
 *
 * The zoom sits in a CORNER of the photo, not beside the pointer: a lens
 * that follows the pointer covers the next thing the eye goes to, and on a
 * phone the finger already covers the spot itself. It takes the corner
 * farthest from what it magnifies, so it can never cover that.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Corner {
  top: boolean;
  left: boolean;
}

/** How much the zoom magnifies what is on screen: three displayed pixels
 * for every one, whatever size the photo is shown at. */
export const LOUPE_ZOOM = 3;
/** The zoom's size on a canvas with room for it, in CSS pixels (4:3). */
export const LOUPE_SIZE: Size = { width: 160, height: 120 };
/** Between the zoom and the photo's edge, in CSS pixels. */
export const LOUPE_INSET = 8;
/** The zoom's white frame, in CSS pixels, inside its size: what it shows
 * fills the rest (`loupeInner`). */
export const LOUPE_FRAME = 2;
// The zoom never takes more than this share of the canvas on either axis,
// so the corner opposite the pointer always leaves the pointer uncovered: a
// zoom narrower than half the canvas (less the inset) cannot reach the
// middle from a corner.
const MAX_SHARE = 0.42;
// How far past the middle the pointer must go before the zoom changes
// sides, as a share of the canvas: without it, a pointer resting on the
// middle line makes the zoom flicker from one corner to the other.
const HYSTERESIS = 0.06;

/**
 * The zoom's size on a `canvas` of this many CSS pixels: LOUPE_SIZE, or
 * smaller on a small canvas, keeping its 4:3 shape.
 */
export function loupeSize(canvas: Size): Size {
  const ratio = LOUPE_SIZE.height / LOUPE_SIZE.width;
  const width = Math.max(0, Math.min(LOUPE_SIZE.width, canvas.width * MAX_SHARE, (canvas.height * MAX_SHARE) / ratio));
  return { width, height: width * ratio };
}

/**
 * The corner of the canvas farthest from `at` (CSS pixels from the canvas's
 * top left): the side of each axis opposite the pointer. With `previous`,
 * the zoom keeps its side until the pointer is clearly across the middle,
 * but never so long that it would cover the pointer.
 */
export function loupeCorner(at: Pt, canvas: Size, size: Size, previous: Corner | null = null): Corner {
  const side = (value: number, length: number, extent: number, wasLow: boolean | undefined) => {
    const middle = length / 2;
    // A zoom on the low side spans [inset, inset + extent]: the pointer
    // must stay past that for it to stay there.
    const slack = Math.max(0, Math.min(length * HYSTERESIS, middle - LOUPE_INSET - extent - 1));
    // "Low" is the top, or the left: the zoom goes there when the pointer
    // is in the high half, and the other way round.
    if (wasLow === undefined) return value > middle;
    return wasLow ? value > middle - slack : value > middle + slack;
  };
  return {
    top: side(at.y, canvas.height, size.height, previous?.top),
    left: side(at.x, canvas.width, size.width, previous?.left),
  };
}

/** What the zoom shows, inside its frame: the size to hand `loupeView`,
 * so what the eye sees is exactly LOUPE_ZOOM times the photo. */
export function loupeInner(size: Size): Size {
  return {
    width: Math.max(0, size.width - 2 * LOUPE_FRAME),
    height: Math.max(0, size.height - 2 * LOUPE_FRAME),
  };
}

/** Where the zoom's top left sits in the canvas, in CSS pixels. */
export function loupeOrigin(corner: Corner, canvas: Size, size: Size): Pt {
  return {
    x: corner.left ? LOUPE_INSET : canvas.width - LOUPE_INSET - size.width,
    y: corner.top ? LOUPE_INSET : canvas.height - LOUPE_INSET - size.height,
  };
}

/**
 * The part of the photo the zoom shows, as an SVG viewBox in IMAGE pixels:
 * centred on `center` (image pixels), exactly LOUPE_ZOOM times what the
 * photo shows at `scale` screen pixels per image pixel. Drawn from the
 * photo itself, so the zoom is as sharp as the photo, not a blown-up copy
 * of the screen.
 */
export function loupeView(center: Pt, scale: number, size: Size): string {
  const width = size.width / (scale * LOUPE_ZOOM);
  const height = size.height / (scale * LOUPE_ZOOM);
  const f = (v: number) => Number(v.toFixed(3));
  return `${f(center.x - width / 2)} ${f(center.y - height / 2)} ${f(width)} ${f(height)}`;
}

/** Does a zoom at `corner` cover the point `at` (CSS pixels)? */
export function loupeCovers(at: Pt, corner: Corner, canvas: Size, size: Size): boolean {
  const o = loupeOrigin(corner, canvas, size);
  return at.x >= o.x && at.x <= o.x + size.width && at.y >= o.y && at.y <= o.y + size.height;
}
