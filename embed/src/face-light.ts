/**
 * The picture's own light, read once from the face: how bright its
 * brightest skin or sclera is. The lips give the mouth its colour and the
 * cheeks its exposure (engine.sampleLipColour); this gives the teeth their
 * ceiling, because enamel brighter than anything else in the photograph is
 * what makes it read as pasted in.
 */

/** The face's silhouette, MediaPipe's face-oval landmarks in order. */
export const FACE_OVAL: readonly number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** The percentile of the face's luma read as its highlight: high enough to
 *  be the sclera or a lit cheekbone, low enough to ignore a glint. */
export const HIGHLIGHT_SHARE = 0.97;

export function insidePolygon(poly: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The luma below which `share` of `samples` fall; null with no samples. */
export function lumaPercentile(samples: readonly number[], share: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * share)))];
}

/**
 * The highlight luma of the face `oval` (texture pixels) from `pixel`, a
 * box-filtered copy of the oval's bounding box `grid` samples across: the
 * HIGHLIGHT_SHARE percentile of the samples that fall inside the silhouette.
 */
export function faceHighlight(
  oval: readonly { x: number; y: number }[],
  pixel: (column: number, row: number) => readonly number[] | null,
  grid: number,
): number | null {
  if (oval.length < 8 || grid < 2) return null;
  const x0 = Math.min(...oval.map((p) => p.x)), x1 = Math.max(...oval.map((p) => p.x));
  const y0 = Math.min(...oval.map((p) => p.y)), y1 = Math.max(...oval.map((p) => p.y));
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const samples: number[] = [];
  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const x = x0 + ((column + 0.5) * (x1 - x0)) / grid, y = y0 + ((row + 0.5) * (y1 - y0)) / grid;
      if (!insidePolygon(oval, x, y)) continue;
      const c = pixel(column, row);
      if (c) samples.push(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
    }
  }
  return lumaPercentile(samples, HIGHLIGHT_SHARE);
}
