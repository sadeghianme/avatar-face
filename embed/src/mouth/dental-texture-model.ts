/** Extract intact dental surfaces. Colour identifies seeds, never opacity. */
export interface DentalPixels { width: number; height: number; data: Uint8ClampedArray }
export interface DentalLayer { pixels: DentalPixels; box: { x: number; y: number; width: number; height: number }; count: number }
export interface DentalContour { x: number; y: number }
const smooth = (a: number, b: number, n: number) => {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function enamelMask(r: number, g: number, b: number): number {
  return smooth(70, 130, Math.min(r, g, b)) * smooth(.72, .86, g / Math.max(r, 1)) * smooth(.57, .76, b / Math.max(r, 1));
}
function boundary(points: DentalContour[], x: number): number {
  for (let i = 1; i < points.length; i++) if (x <= points[i].x) {
    const a = points[i - 1], b = points[i];
    const t = Math.max(0, Math.min(1, (x - a.x) / Math.max(.001, b.x - a.x)));
    return a.y + (b.y - a.y) * t;
  }
  return points[points.length - 1].y;
}
export function extractDentalLayers(image: DentalPixels, upperContour: DentalContour[], lowerContour: DentalContour[]): [DentalLayer, DentalLayer] {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.data.length !== image.width * image.height * 4 || [upperContour, lowerContour].some(contour =>
        contour.length < 2 || contour.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) {
    throw new Error("Invalid dental image or lip contours");
  }
  const upper = [...upperContour].sort((a, b) => a.x - b.x), lower = [...lowerContour].sort((a, b) => a.x - b.x);
  const blank = (): DentalLayer => ({ pixels: { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data.length) }, box: { x: image.width, y: image.height, width: 0, height: 0 }, count: 0 });
  const layers: [DentalLayer, DentalLayer] = [blank(), blank()];
  const x0 = Math.ceil(Math.max(upper[0].x, lower[0].x)), x1 = Math.floor(Math.min(upper[upper.length - 1].x, lower[lower.length - 1].x));
  for (let x = Math.max(0, x0); x <= Math.min(image.width - 1, x1); x++) {
    const top = boundary(upper, x), bottom = boundary(lower, x);
    if (bottom - top < 2) continue;
    // Locate the dark inter-arch gap instead of copying a rectangular crop.
    let split = top + (bottom - top) * .6, best = Infinity;
    for (let y = Math.max(0, Math.ceil(top + (bottom - top) * .28)); y < Math.min(image.height, bottom - (bottom - top) * .18); y++) {
      let value = 0;
      for (let dx = -2; dx <= 2; dx++) value += image.data[(y * image.width + Math.max(0, Math.min(image.width - 1, x + dx))) * 4 + 1];
      const preference = Math.abs((y - top) / (bottom - top) - .6) * 20;
      if (value / 5 + preference < best) { best = value / 5 + preference; split = y; }
    }
    for (let y = Math.max(0, Math.ceil(top)); y < Math.min(image.height, bottom); y++) {
      const k = (y * image.width + x) * 4;
      const [r, g, b, sourceAlpha] = image.data.subarray(k, k + 4);
      // Classification is only a seed for the silhouette. Using its score as
      // alpha punches holes through shaded enamel and creates black cracks.
      if (sourceAlpha < 40 || enamelMask(r, g, b) < .35) continue;
      const layer = layers[y < split ? 0 : 1];
      layer.pixels.data.set([r, g, b, sourceAlpha], k); layer.count++;
    }
  }
  // Reject isolated highlights before constructing a continuous arch.
  for (const layer of layers) {
    const { width, height, data } = layer.pixels;
    const seen = new Uint8Array(width * height);
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || data[start * 4 + 3] < 40) continue;
      const queue = [start]; seen[start] = 1;
      for (let j = 0; j < queue.length; j++) {
        const i = queue[j], x = i % width, y = Math.floor(i / width);
        for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
          if (n >= 0 && !seen[n] && data[n * 4 + 3] >= 40) { seen[n] = 1; queue.push(n); }
        }
      }
      if (queue.length < (layer === layers[0] ? 150 : 12)) for (const i of queue) { data[i * 4 + 3] = 0; layer.count--; }
    }
    // Keep the photograph's own shading inside each crown and between teeth.
    // Only the outer silhouette is transparent. Bridge short unseeded columns
    // (interdental shadows), not missing side teeth or empty mouth corners.
    const tops = new Float64Array(width).fill(NaN), bottoms = new Float64Array(width).fill(NaN);
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4 + 3] < 40) continue;
      if (!Number.isFinite(tops[x])) tops[x] = y;
      bottoms[x] = y;
    }
    const bridge = Math.max(2, Math.round((x1 - x0) * .035));
    let previous = -1;
    for (let x = 0; x < width; x++) {
      if (!Number.isFinite(tops[x])) continue;
      if (previous >= 0 && x - previous <= bridge) for (let n = previous + 1; n < x; n++) {
        const t = (n - previous) / (x - previous);
        tops[n] = tops[previous] * (1 - t) + tops[x] * t;
        bottoms[n] = bottoms[previous] * (1 - t) + bottoms[x] * t;
      }
      previous = x;
    }
    data.fill(0); layer.count = 0;
    for (let x = 0; x < width; x++) {
      if (!Number.isFinite(tops[x])) continue;
      for (let y = Math.ceil(tops[x]); y <= Math.floor(bottoms[x]); y++) {
        const k = (y * width + x) * 4;
        data.set(image.data.subarray(k, k + 4), k);
        if (data[k + 3] >= 40) layer.count++;
      }
    }
    // Papillae and root-contact shadows are part of the surface too. Close
    // short horizontal notches with their original pixels, otherwise the
    // cavity appears as black wedges between the tops of adjacent crowns.
    for (let y = 0; y < height; y++) {
      let last = -1;
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 40) continue;
        if (last >= 0 && x - last <= bridge) for (let n = last + 1; n < x; n++) {
          const k = (y * width + n) * 4;
          data.set(image.data.subarray(k, k + 4), k);
          if (data[k + 3] >= 40) layer.count++;
        }
        last = x;
      }
    }
    let maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 40) continue;
      layer.box.x = Math.min(layer.box.x, x); layer.box.y = Math.min(layer.box.y, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    layer.box.width = Math.max(0, maxX - layer.box.x + 1); layer.box.height = Math.max(0, maxY - layer.box.y + 1);
  }
  return layers;
}
/** Upper arch is skull-fixed. The lower arch moves rigidly; neither changes
 * size with vowel width or aperture height. All units are neutral-mouth widths. */
export function dentalPlacement(lower: boolean, sourceWidth: number, sourceHeight: number, scale: number, offset: number, jaw: number, incisalOffset = 0) {
  // The extraction canvas maps a mouth width to 512 pixels. Preserve this
  // scale: fitting a cropped row to an arbitrary width enlarges the incisors.
  const width = sourceWidth / 512 * scale, height = sourceHeight / 512 * scale;
  const opening = Math.max(0, Math.min(1, jaw));
  const y = lower ? opening * .32 - .055 - incisalOffset / 512 * scale : .055 + offset;
  return { x: -width / 2, y: lower ? y : y - height, width, height };
}

/** Do not render a subpixel strip of lower enamel as the lips close. Expose
 * the lower arch continuously only when there is room below the upper row. */
export function lowerDentalExposure(descent: number, upperIncisal: number): number {
  return smooth(.045, .095, descent - upperIncisal);
}

/** A tip-only photo cannot cover a lifted upper lip without inventing roots. */
export function dentalCrownCoverage(layer: DentalLayer, center: number, mouthWidth: number): number {
  const heights: number[] = [];
  const { width, height, data } = layer.pixels;
  for (let x = Math.max(0, Math.ceil(center - mouthWidth * .025)); x <= Math.min(width - 1, center + mouthWidth * .025); x++) {
    let first = -1, last = -1;
    for (let y = 0; y < height; y++) if (data[(y * width + x) * 4 + 3] >= 150) {
      if (first < 0) first = y;
      last = y;
    }
    heights.push(first < 0 ? 0 : last - first + 1);
  }
  return heights.length && mouthWidth > 0 ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] / mouthWidth : 0;
}
