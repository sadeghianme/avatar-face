/**
 * The viewport: how the whole picture is laid on the canvas.
 *
 * The picture is never cropped. "Face" and "full" are two zoom levels of a
 * window over the same whole picture, and whatever falls outside the
 * canvas is simply outside — no rectangle is cut out of the picture first,
 * so no edge of a crop can ever show inside the canvas, and a cut-out's
 * own outline is the only edge it has. (The framing this replaces cut a
 * box around the face and fitted that box into the canvas: the shoulders
 * ended in a straight line under the chin, and a canvas of another aspect
 * showed the box's edges with bands beside them.)
 *
 *  - "face" (zoom 1): the canvas is filled — COVER — by a view that runs
 *    from the hair above the face box down to the picture's bottom edge,
 *    a quarter of the face's width to each side; the face box sits centred
 *    across the canvas and the eyes at EYE_LINE of its height, as a
 *    portrait is composed. The scale never goes so far that the face from
 *    the brows to below the chin would not fit the canvas height (a wide
 *    banner then shows the picture's own sides rather than cutting the
 *    mouth off), nor past MAX_UPSCALE of the picture's own pixels (a small
 *    picture keeps its sharpness and the canvas background shows beside it,
 *    rather than a blur filling the canvas).
 *  - "full" (zoom 0): the whole picture, CONTAINED and centred.
 *  - Between: the two laid over each other in proportion.
 */

export interface ViewportInput {
  /** The picture's size, in rig image pixels. */
  imageW: number;
  imageH: number;
  /** The face box, rig image pixels: x0, y0, x1, y1. */
  faceBox: readonly [number, number, number, number];
  /** The eye line's height, rig image pixels. */
  eyeY: number;
  canvasW: number;
  canvasH: number;
  /** 1 is the face, 0 the whole picture, up to ZOOM_MAX closer in. */
  zoom: number;
  /** The owner's move of the view from its own placement, as fractions of
   *  the canvas (x to the right, y down): the picture moves the other way.
   *  Clamped so the picture still covers the canvas where it can. */
  pan?: { x: number; y: number };
}

/** The mapping rig image px -> canvas px: canvas = image * scale + offset. */
export interface Viewport { scale: number; offsetX: number; offsetY: number }

/** Where the eyes sit on a "face" canvas, as a fraction of its height. */
export const EYE_LINE = 0.4;
/** The picture is never drawn larger than this many times its own pixels. */
export const MAX_UPSCALE = 2;
/** The furthest zoom: 1.3 draws the face view ZOOM_IN_GAIN * 0.3 + 1 =
 *  1.6 times larger, eyes still on the line. */
export const ZOOM_MAX = 1.3;
const ZOOM_IN_GAIN = 2;
/** The furthest a pan moves the view, as a fraction of the canvas. */
export const PAN_MAX = 1;

const panOf = (i: ViewportInput): { x: number; y: number } => ({
  x: clamp(Number.isFinite(i.pan?.x ?? 0) ? (i.pan?.x ?? 0) : 0, -PAN_MAX, PAN_MAX),
  y: clamp(Number.isFinite(i.pan?.y ?? 0) ? (i.pan?.y ?? 0) : 0, -PAN_MAX, PAN_MAX),
});

/** The picture kept over the canvas where it is big enough to cover it,
 *  and inside the canvas where it is not. */
const settle = (offset: number, picture: number, canvas: number): number =>
  picture >= canvas ? clamp(offset, canvas - picture, 0) : clamp(offset, 0, canvas - picture);
/** The face view's margins, as fractions of the face box: to each side,
 *  above (hair) and, for the span that must always fit, below the chin. */
export const FACE_MARGIN = { side: 0.25, top: 0.55, chin: 0.12 } as const;
/** The span that must always fit the canvas height: from the brows (a
 *  quarter down the face box) to a little below the chin. */
const BROW = 0.25;

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

/** The whole picture, contained and centred; a pan slides it within the
 *  room the canvas has beside it. */
export function fullViewport(i: ViewportInput): Viewport {
  const scale = Math.min(i.canvasW / i.imageW, i.canvasH / i.imageH, MAX_UPSCALE);
  const pan = panOf(i);
  const pictureW = i.imageW * scale, pictureH = i.imageH * scale;
  return {
    scale,
    offsetX: settle((i.canvasW - pictureW) / 2 - pan.x * i.canvasW, pictureW, i.canvasW),
    offsetY: settle((i.canvasH - pictureH) / 2 - pan.y * i.canvasH, pictureH, i.canvasH),
  };
}

/** The face, composed as a portrait. */
export function faceViewport(i: ViewportInput): Viewport {
  const [bx0, by0, bx1, by1] = i.faceBox;
  const bw = Math.max(1, bx1 - bx0), bh = Math.max(1, by1 - by0);
  // The view: hair margin above, the face's own margin to each side, down
  // to the picture's bottom edge, all inside the picture.
  const vx0 = Math.max(0, bx0 - bw * FACE_MARGIN.side);
  const vx1 = Math.min(i.imageW, bx1 + bw * FACE_MARGIN.side);
  const vy0 = Math.max(0, by0 - bh * FACE_MARGIN.top);
  const vy1 = i.imageH;
  const viewW = Math.max(1, vx1 - vx0), viewH = Math.max(1, vy1 - vy0);
  // The span that must fit: brows to below the chin.
  const my0 = Math.max(0, by0 + bh * BROW);
  const my1 = Math.min(i.imageH, by1 + bh * FACE_MARGIN.chin);
  const mustH = Math.max(1, my1 - my0);

  let scale = Math.max(i.canvasW / viewW, i.canvasH / viewH);
  scale = Math.min(scale, i.canvasH / mustH, MAX_UPSCALE);
  // Closer in than the face view, when asked: the owner's choice, so the
  // brows and chin may leave the canvas; the picture's own pixels still
  // bound it.
  const closer = clamp(Number.isFinite(i.zoom) ? i.zoom : 1, 1, ZOOM_MAX) - 1;
  if (closer > 0) scale = Math.min(scale * (1 + closer * ZOOM_IN_GAIN), MAX_UPSCALE);

  const pan = panOf(i);
  const pictureW = i.imageW * scale, pictureH = i.imageH * scale;
  // Across: the face box centred, then the owner's pan, as far as the
  // picture still covers the canvas; a picture narrower than the canvas
  // sits where the pan puts it, inside the canvas.
  const offsetX = settle(i.canvasW / 2 - ((bx0 + bx1) / 2) * scale - pan.x * i.canvasW, pictureW, i.canvasW);
  // Down: the eyes at EYE_LINE, moved only as far as keeping the brows and
  // the chin on the canvas needs (at the face view: closer in, the owner
  // decides), then the pan, and the picture still covering it.
  let offsetY = i.canvasH * EYE_LINE - i.eyeY * scale;
  // Brows on the canvas: offsetY >= -my0 * scale; the chin's margin on it:
  // offsetY <= canvasH - my1 * scale. The scale cap above keeps the two
  // compatible at the face view.
  if (closer === 0) offsetY = clamp(offsetY, -my0 * scale, i.canvasH - my1 * scale);
  offsetY = settle(offsetY - pan.y * i.canvasH, pictureH, i.canvasH);
  return { scale, offsetX, offsetY };
}

/** The viewport at a zoom: the face at 1 (and closer in above it, to
 *  ZOOM_MAX), the whole picture at 0, laid over each other in proportion
 *  between. */
export function viewportFor(i: ViewportInput): Viewport {
  const z = clamp(Number.isFinite(i.zoom) ? i.zoom : 1, 0, ZOOM_MAX);
  if (z >= 1) return faceViewport({ ...i, zoom: z });
  const full = fullViewport(i);
  if (z <= 0) return full;
  const face = faceViewport({ ...i, zoom: 1 });
  return {
    scale: full.scale + (face.scale - full.scale) * z,
    offsetX: full.offsetX + (face.offsetX - full.offsetX) * z,
    offsetY: full.offsetY + (face.offsetY - full.offsetY) * z,
  };
}

/** The eye line of a face mesh: the mean height of the eye corners. */
export function eyeLine(points: readonly (readonly [number, number])[], faceBox: readonly [number, number, number, number]): number {
  const corners = [33, 133, 263, 362].filter((k) => k < points.length);
  if (corners.length < 4) return faceBox[1] + (faceBox[3] - faceBox[1]) * 0.35;
  return corners.reduce((sum, k) => sum + points[k][1], 0) / corners.length;
}
