import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FaceMesh, HeadGeom, Point } from "../geometry";
import { MeshWarp } from "../mesh-warp";
import { composeFrame, cutHeadLayer, type HeadLayer } from "../render2d";

/**
 * A cut-out's seams, in real pixels (Skia, @napi-rs/canvas): the head's
 * feathered layer and the warped mesh must leave the canvas exactly as the
 * still picture left it at rest, half-transparent edges included, and the
 * head's layer must have no edge that shows when it moves.
 *
 * The picture: a 200 x 160 cut-out whose subject is ringed by a wide band
 * of half-transparent pixels (a cut-out's hair strands and matte fringe),
 * laid at a fractional offset and scale, as a viewport lays it.
 */

const W = 240,
  H = 200;
let texture: HTMLImageElement;

beforeAll(async () => {
  const c = createCanvas(200, 160);
  const g = c.getContext("2d");
  // Stripes of colour, so a moved copy differs from a still one.
  for (let x = 0; x < 200; x += 8) {
    g.fillStyle = x % 16 ? "rgb(200,120,60)" : "rgb(90,160,220)";
    g.fillRect(x, 0, 8, 160);
  }
  // Clear outside an ellipse, and fade a 14 px rim to transparency.
  const img = g.getImageData(0, 0, 200, 160);
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 200; x++) {
      const r = Math.hypot((x - 100) / 80, (y - 80) / 70);
      const a = Math.max(0, Math.min(1, (1.05 - r) / 0.2));
      img.data[(y * 200 + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  texture = (await loadImage(c.toBuffer("image/png"))) as unknown as HTMLImageElement;
});

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
});
afterEach(() => vi.unstubAllGlobals());

/** The picture laid on the canvas: rig px x 1.07 + (13.3, 9.6). */
const scale = 1.07,
  offsetX = 13.3,
  offsetY = 9.6;
const picture = { x: offsetX, y: offsetY, w: 200 * scale, h: 160 * scale };

/** A coarse mesh over the subject: a 5 x 4 grid, rest = texture px laid. */
function gridMesh(): FaceMesh {
  const texPoints: Point[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) texPoints.push({ x: 30 + i * 35, y: 25 + j * 35 });
  const basePoints = texPoints.map((p) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }));
  const triangles: [number, number, number][] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 4; i++) {
      const a = j * 5 + i;
      triangles.push([a, a + 1, a + 6], [a, a + 6, a + 5]);
    }
  }
  return { scale, offsetX, offsetY, picture, basePoints, texPoints, derivedParents: [], neckBand: [], triangles };
}

/** A head rectangle with fractional edges, narrower than the mesh at the
 *  sides and short of it at the bottom (as placeHead's is of a neck band). */
const geom: HeadGeom = {
  x: 50.4,
  y: 15.6,
  w: 140.3,
  h: 120.7,
  pivotX: 120,
  pivotY: 190,
  yawPx: 4,
  pitchPx: 3,
  faceH: 60,
  bustPivotY: 175,
  bustReach: 110,
};

type Ctx = CanvasRenderingContext2D;
function stage(): { ctx: Ctx; read(): Uint8ClampedArray } {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d") as unknown as Ctx;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { ctx, read: () => (ctx.getImageData(0, 0, W, H).data as unknown as Uint8ClampedArray).slice() };
}
const drawPicture = (ctx: Ctx) => ctx.drawImage(texture, 0, 0, 200, 160, picture.x, picture.y, picture.w, picture.h);

/** The frame as the engine composes a cut-out's (render2d.ts), the head
 *  moved by (dx, dy), no mesh; with its head layer, or (null) as one. */
function compose(ctx: Ctx, layer: HeadLayer | null, dx = 0, dy = 0, roll = 0) {
  composeFrame({
    ctx,
    picture,
    texture,
    layers: null,
    cutOut: true,
    head: geom,
    headLayer: layer,
    headOffset: { dx, dy, roll, fdx: 0, fdy: 0 },
    bodyLean: null,
    drawMesh: () => undefined,
    drawFeatures: () => undefined,
  });
}

/** Largest channel difference, premultiplied (as the canvas shows it). */
function maxDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3] / 255,
      ba = b[i + 3] / 255;
    for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(a[i + k] * aa - b[i + k] * ba));
    max = Math.max(max, Math.abs(a[i + 3] - b[i + 3]));
  }
  return max;
}

describe("a cut-out without its head layer (the default)", () => {
  it("moves as one picture: the bust leans from low on the chest, the face as far as the head", () => {
    const dx = 2.6,
      dy = 1.8,
      roll = 0.01;
    let drawnWith: DOMMatrix | null = null;
    const moved = stage();
    const draw = moved.ctx.drawImage.bind(moved.ctx);
    let draws = 0;
    moved.ctx.drawImage = ((...a: Parameters<Ctx["drawImage"]>) => {
      draws++;
      drawnWith = moved.ctx.getTransform();
      return draw(...a);
    }) as Ctx["drawImage"];
    compose(moved.ctx, null, dx, dy, roll);
    // One picture, drawn once: nothing erased, nothing added back.
    expect(draws).toBe(1);
    const m = drawnWith!;
    const at = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    // The pivot stays; the face's centre travels the head's shift (and the
    // roll's share of the lever), the shoulders' line a fraction of it.
    const pivot = at(geom.pivotX, geom.bustPivotY);
    expect(pivot.x).toBeCloseTo(geom.pivotX, 4);
    expect(pivot.y).toBeCloseTo(geom.bustPivotY, 4);
    const faceY = geom.bustPivotY - geom.bustReach;
    const face = at(geom.pivotX, faceY);
    // Sheared by dx over the reach, foreshortened by dy, rolled.
    const r = geom.bustReach - dy;
    expect(face.x - geom.pivotX).toBeCloseTo(dx * (r / geom.bustReach) * Math.cos(roll) + r * Math.sin(roll), 3);
    expect(face.y - faceY).toBeCloseTo(
      geom.bustReach - r * Math.cos(roll) + dx * (r / geom.bustReach) * Math.sin(roll),
      3
    );
    expect(face.y - faceY).toBeCloseTo(dy, 0);
    // The shoulders' line, a third of the reach up: a fraction of the
    // face's travel, and level but for the roll.
    const sy = geom.bustPivotY - geom.bustReach * 0.3;
    const left = at(geom.pivotX - 60, sy),
      right = at(geom.pivotX + 60, sy);
    expect(Math.abs((left.x + right.x) / 2 - geom.pivotX)).toBeLessThan(Math.abs(face.x - geom.pivotX) * 0.35);
    expect(Math.abs(Math.atan2(right.y - left.y, right.x - left.x) - roll)).toBeLessThan(1e-3);
    // And it is the still picture through that transform, pixel for pixel.
    const ref = stage();
    ref.ctx.setTransform(m);
    drawPicture(ref.ctx);
    expect(maxDiff(ref.read(), moved.read())).toBe(0);
  });
});

describe("a cut-out's head layer (opted into)", () => {
  it("is the texture's own pixels, feathered to nothing at its every edge, and whole over the mesh", () => {
    const mesh = gridMesh();
    const layer = cutHeadLayer(texture, mesh, geom)!;
    // Whole texture pixels, laid where the picture lays them.
    const { width: w, height: h } = layer.mask;
    expect(layer.w).toBeCloseTo(w * scale, 9);
    expect(layer.h).toBeCloseTo(h * scale, 9);
    for (const at of [(layer.x - picture.x) / scale, (layer.y - picture.y) / scale]) {
      expect(Math.abs(at - Math.round(at))).toBeLessThan(1e-9);
    }
    const m = layer.mask.getContext("2d")!.getImageData(0, 0, w, h).data;
    const alpha = (x: number, y: number) => m[(y * w + x) * 4 + 3];
    // Every edge pixel of the mask, where the picture does not end there:
    // nothing left to show as a line when the layer moves. (A layer whose
    // last row was left unfeathered held alpha 113 there.)
    let edge = 0;
    for (let x = 0; x < w; x++) {
      if (layer.y > picture.y + 1) edge = Math.max(edge, alpha(x, 0));
      if (layer.y + layer.h < picture.y + picture.h - 1) edge = Math.max(edge, alpha(x, h - 1));
    }
    for (let y = 0; y < h; y++) {
      if (layer.x > picture.x + 1) edge = Math.max(edge, alpha(0, y));
      if (layer.x + layer.w < picture.x + picture.w - 1) edge = Math.max(edge, alpha(w - 1, y));
    }
    expect(edge).toBeLessThanOrEqual(14);
    // Whole over every vertex the mesh draws (and the geom's own rectangle
    // grown to hold them).
    for (const p of mesh.basePoints) {
      expect(alpha(Math.round((p.x - layer.x) / scale), Math.round((p.y - layer.y) / scale))).toBe(255);
    }
  });

  it("leaves the picture exactly as it was at rest, half-transparent rim and all", () => {
    const layer = cutHeadLayer(texture, gridMesh(), geom)!;
    const still = stage();
    drawPicture(still.ctx);
    const composed = stage();
    compose(composed.ctx, layer);
    // Erasing by the layer's own alpha (the picture's x the mask) instead of
    // the mask brought the rim back as alpha x (2 - alpha): 60+ levels.
    expect(maxDiff(still.read(), composed.read())).toBeLessThanOrEqual(10);
  });

  it("moved, blends into the still body with no line at its edge", () => {
    const layer = cutHeadLayer(texture, gridMesh(), geom)!;
    const still = stage();
    drawPicture(still.ctx);
    const moved = stage();
    compose(moved.ctx, layer, 2.6, -1.8);
    const a = still.read(),
      b = moved.read();
    // Along the mask's outer edge, the frame is the still picture: the
    // feather has run out.
    const x0 = Math.floor(layer.x),
      y0 = Math.floor(layer.y),
      x1 = Math.ceil(layer.x + layer.w) - 1,
      y1 = Math.ceil(layer.y + layer.h) - 1;
    let worst = 0;
    const at = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      worst = Math.max(worst, maxDiff(a.subarray(i, i + 4), b.subarray(i, i + 4)));
    };
    // The edge row or column, still and moved, and out from it: what is
    // left there is the feather's last step, a band's 1 / (2 width) of the
    // difference. An unfeathered last row (the fractional rectangle on a
    // rounded canvas) left 40% of it, a line.
    for (let d = 0; d <= 3; d++) {
      for (let x = x0 - 3; x <= x1 + 3; x++) {
        at(x, y0 - d);
        at(x, y1 + d);
      }
      for (let y = y0 - 3; y <= y1 + 3; y++) {
        at(x0 - d, y);
        at(x1 + d, y);
      }
    }
    expect(worst).toBeLessThanOrEqual(8);
  });
});

describe("the warped mesh over a cut-out, in 2D", () => {
  /** The picture, and the mesh warped over it at `pts`; both read back. */
  function warped(replace: boolean, pts: Point[]) {
    const mesh = gridMesh();
    const still = stage();
    drawPicture(still.ctx);
    const framed = stage();
    drawPicture(framed.ctx);
    const canvas = createCanvas(W, H) as unknown as HTMLCanvasElement;
    const warp = new MeshWarp(canvas, "2d", [], () => ({
      texture,
      mesh,
      padEverywhere: true,
      lowerFace: null,
      replace,
    }));
    warp.draw(framed.ctx, pts, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    return { still: still.read(), framed: framed.read() };
  }
  const rest = () => gridMesh().basePoints.map((p) => ({ ...p }));

  it("at rest leaves the picture as it was, rim and seam pads included", () => {
    const { still, framed } = warped(true, rest());
    expect(maxDiff(still, framed)).toBeLessThanOrEqual(1);
  });

  it("(laid over instead, a half-transparent pixel composites over itself)", () => {
    const { still, framed } = warped(false, rest());
    expect(maxDiff(still, framed)).toBeGreaterThan(30);
  });

  it("moved, replaces what is under it: no half-transparent pixel composited over itself", () => {
    // Every vertex shifted alike: inside the mesh the frame is the picture
    // shifted, its half-transparent rim too. Laid over the picture, the rim
    // came out alpha x (2 - alpha) wherever the mesh covers it.
    const shift = { x: 0.6, y: 0.4 };
    const pts = rest().map((p) => ({ x: p.x + shift.x, y: p.y + shift.y }));
    const { framed } = warped(true, pts);
    const want = stage();
    want.ctx.translate(shift.x, shift.y);
    drawPicture(want.ctx);
    const ref = want.read();
    const mesh = gridMesh();
    const xs = mesh.basePoints.map((p) => p.x),
      ys = mesh.basePoints.map((p) => p.y);
    let worst = 0;
    for (let y = Math.ceil(Math.min(...ys)) + 3; y < Math.max(...ys) - 3; y++) {
      for (let x = Math.ceil(Math.min(...xs)) + 3; x < Math.max(...xs) - 3; x++) {
        const i = (y * W + x) * 4;
        worst = Math.max(worst, maxDiff(framed.subarray(i, i + 4), ref.subarray(i, i + 4)));
      }
    }
    expect(worst).toBeLessThanOrEqual(6);
    expect(maxDiff(warped(false, pts).framed, ref)).toBeGreaterThan(30);
  });

  it("moved, redraws what moved and leaves every still triangle as the picture", () => {
    // One interior vertex (row 1, column 2) moved: only its six triangles
    // change; the picture elsewhere, the rim included, is untouched.
    const pts = rest();
    pts[7] = { x: pts[7].x + 4, y: pts[7].y + 3 };
    const { still, framed } = warped(true, pts);
    const mesh = gridMesh();
    const near = (x: number, y: number) =>
      mesh.triangles.some(
        (t) =>
          t.includes(7) &&
          Math.min(...t.map((i) => Math.hypot(pts[i].x - x, pts[i].y - y))) <
            Math.max(...t.map((i) => Math.hypot(pts[i].x - pts[t[0]].x, pts[i].y - pts[t[0]].y))) + 3
      );
    let far = 0,
      changed = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = maxDiff(still.subarray(i, i + 4), framed.subarray(i, i + 4));
        if (near(x, y)) changed = Math.max(changed, d);
        else far = Math.max(far, d);
      }
    }
    expect(changed).toBeGreaterThan(20);
    expect(far).toBeLessThanOrEqual(1);
  });
});
