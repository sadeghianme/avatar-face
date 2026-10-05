/**
 * The browser the 2D engine expects, as far as geometry needs it.
 *
 * The engine samples the picture through 2D canvases (lip colour, lashes,
 * the cut-out probe, the character look) and schedules frames; none of
 * that moves a vertex. In Node the canvases draw nothing and read back one
 * flat, opaque colour, frames never fire, and the deformation runs on the
 * rig's geometry alone — which is all the bake records.
 */

export type Pixel = [number, number, number, number];

export function fakeContext(fill: Pixel) {
  const target: Record<string, unknown> = {
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      for (let i = 0; i < data.length; i += 4) data.set(fill, i);
      return { data, width: w, height: h };
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(target, {
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value) => ((obj[key] = value), true),
  });
}

export function fakeCanvas(size: number, fill: Pixel = [182, 128, 110, 255]): HTMLCanvasElement {
  const ctx = fakeContext(fill);
  return {
    width: size,
    height: size,
    style: {},
    dataset: {},
    getContext: () => ctx,
    setAttribute() {},
    dispatchEvent: () => true,
  } as unknown as HTMLCanvasElement;
}

class NoopPath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  ellipse() {}
  rect() {}
  closePath() {}
  addPath() {}
}

/** Install the stand-ins once; harmless in a browser that has the real things. */
export function installNodeEnvironment(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g.document) g.document = { createElement: () => fakeCanvas(64) };
  if (!g.requestAnimationFrame) g.requestAnimationFrame = () => 1;
  if (!g.cancelAnimationFrame) g.cancelAnimationFrame = () => undefined;
  if (!g.Path2D) g.Path2D = NoopPath;
  if (!g.window) g.window = g;
}
