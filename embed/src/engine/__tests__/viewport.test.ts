import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EYE_LINE,
  eyeLine,
  faceViewport,
  fullViewport,
  MAX_UPSCALE,
  viewportFor,
  type ViewportInput,
} from "../viewport";
import type { Rig } from "../../types";

/**
 * The viewport: the whole picture laid on the canvas, "face" and "full"
 * as zoom levels. Pinned on the detected human fixture (a 1024 square
 * portrait) and on a tall AI picture (768 x 1376, the wizard's size),
 * across the canvas shapes the product uses.
 */

const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;

const square: Omit<ViewportInput, "canvasW" | "canvasH" | "zoom"> = {
  imageW: rig.image_size[0],
  imageH: rig.image_size[1],
  faceBox: rig.face_box,
  eyeY: eyeLine(rig.points, rig.face_box),
};
/** A wizard picture: the face in the upper half, shoulders below. */
const tall: Omit<ViewportInput, "canvasW" | "canvasH" | "zoom"> = {
  imageW: 768,
  imageH: 1376,
  faceBox: [199, 473, 571, 883],
  eyeY: 620,
};
const SIZES: [number, number][] = [
  [200, 200],
  [300, 400],
  [400, 300],
  [600, 600],
  [800, 300],
  [40, 40],
  [1000, 1000],
];

const at = (base: typeof square, canvasW: number, canvasH: number, zoom: number): ViewportInput => ({
  ...base,
  canvasW,
  canvasH,
  zoom,
});
/** The canvas rectangle the picture covers. */
const picture = (i: ViewportInput, v: { scale: number; offsetX: number; offsetY: number }) => ({
  x0: v.offsetX,
  y0: v.offsetY,
  x1: v.offsetX + i.imageW * v.scale,
  y1: v.offsetY + i.imageH * v.scale,
});

describe("the face zoom", () => {
  for (const [name, base] of [
    ["square portrait", square],
    ["tall picture", tall],
  ] as const) {
    for (const [cw, ch] of SIZES) {
      const i = at(base, cw, ch, 1);
      const v = faceViewport(i);
      const p = picture(i, v);
      const [bx0, by0, bx1, by1] = i.faceBox;
      const bh = by1 - by0;

      it(`${name} ${cw}x${ch}: the face box is centred across the canvas`, () => {
        const centre = ((bx0 + bx1) / 2) * v.scale + v.offsetX;
        // Centred unless the picture's own edge would come inside the
        // canvas, in which case the picture is flush with that edge.
        const flush = p.x0 >= -1e-6 || p.x1 <= cw + 1e-6;
        if (!flush) expect(centre).toBeCloseTo(cw / 2, 6);
        else expect(Math.abs(centre - cw / 2)).toBeLessThan(cw / 2);
      });

      it(`${name} ${cw}x${ch}: the brows and the chin are on the canvas`, () => {
        expect((by0 + bh * 0.25) * v.scale + v.offsetY).toBeGreaterThanOrEqual(-1e-6);
        expect((by1 + bh * 0.12) * v.scale + v.offsetY).toBeLessThanOrEqual(ch + 1e-6);
      });

      it(`${name} ${cw}x${ch}: the eyes sit at the eye line, or as near as the face allows`, () => {
        const eyes = i.eyeY * v.scale + v.offsetY;
        // On the line, unless keeping the chin (with its margin) on the
        // canvas needs the eyes higher: then the chin margin sits exactly
        // on the bottom edge. Never lower than the line, never off the top.
        const chinMargin = (by1 + bh * 0.12) * v.scale + v.offsetY;
        if (Math.abs(eyes / ch - EYE_LINE) > 1e-6) {
          expect(eyes / ch).toBeLessThan(EYE_LINE);
          // A square or tall canvas moves them a little; a wide one as far
          // as the brows allow (they stay on the canvas: the test above).
          if (ch >= cw) expect(eyes / ch).toBeGreaterThan(EYE_LINE - 0.1);
          expect(chinMargin).toBeCloseTo(ch, 6);
        }
        expect(eyes).toBeGreaterThan(0);
      });

      it(`${name} ${cw}x${ch}: the canvas is covered top to bottom, and across whenever the picture is wide enough`, () => {
        expect(p.y0).toBeLessThanOrEqual(1e-6);
        expect(p.y1).toBeGreaterThanOrEqual(ch - 1e-6);
        if (i.imageW * v.scale >= cw) {
          expect(p.x0).toBeLessThanOrEqual(1e-6);
          expect(p.x1).toBeGreaterThanOrEqual(cw - 1e-6);
        } else {
          // Narrower: inside the canvas, the face box still centred, the
          // canvas background showing beside it.
          expect(p.x0).toBeGreaterThanOrEqual(-1e-6);
          expect(p.x1).toBeLessThanOrEqual(cw + 1e-6);
          expect(((bx0 + bx1) / 2) * v.scale + v.offsetX).toBeCloseTo(cw / 2, 6);
        }
      });

      it(`${name} ${cw}x${ch}: never past the upscale limit`, () => {
        expect(v.scale).toBeLessThanOrEqual(MAX_UPSCALE + 1e-9);
      });
    }
  }

  it("fills a square canvas as a profile picture: hair to just below the chin, nothing of the picture's edges", () => {
    const i = at(square, 600, 600, 1);
    const v = faceViewport(i);
    const p = picture(i, v);
    expect(p.x0).toBeLessThan(0);
    expect(p.x1).toBeGreaterThan(600);
    expect(p.y0).toBeLessThan(0);
    expect(p.y1).toBeGreaterThan(600);
    // The face box fills most of the width.
    const [bx0, , bx1] = i.faceBox;
    expect(((bx1 - bx0) * v.scale) / 600).toBeGreaterThan(0.55);
    expect(((bx1 - bx0) * v.scale) / 600).toBeLessThan(0.8);
  });

  it("shows the picture's own sides on a wide banner rather than cutting the mouth off", () => {
    const i = at(tall, 800, 300, 1);
    const v = faceViewport(i);
    const p = picture(i, v);
    const [bx0, by0, bx1, by1] = i.faceBox;
    expect(p.x0).toBeGreaterThan(0);
    expect(p.x1).toBeLessThan(800);
    expect(((bx0 + bx1) / 2) * v.scale + v.offsetX).toBeCloseTo(400, 6);
    expect((by1 + (by1 - by0) * 0.12) * v.scale + v.offsetY).toBeLessThanOrEqual(300 + 1e-6);
  });

  it("keeps a small picture sharp: the canvas background shows beside it instead of a blur", () => {
    const i: ViewportInput = {
      imageW: 200,
      imageH: 200,
      faceBox: [50, 40, 150, 170],
      eyeY: 90,
      canvasW: 1000,
      canvasH: 1000,
      zoom: 1,
    };
    const v = faceViewport(i);
    expect(v.scale).toBe(MAX_UPSCALE);
    const p = picture(i, v);
    // Inside the canvas, composed as a portrait: face centred, eyes on the line.
    expect(p.x0).toBeGreaterThanOrEqual(0);
    expect(p.x1).toBeLessThanOrEqual(1000);
    expect(p.y0).toBeGreaterThanOrEqual(0);
    expect(p.y1).toBeLessThanOrEqual(1000);
    expect(100 * v.scale + v.offsetX).toBeCloseTo(500, 6);
    expect((i.eyeY * v.scale + v.offsetY) / 1000).toBeCloseTo(EYE_LINE, 6);
  });
});

describe("the full zoom", () => {
  for (const [name, base] of [
    ["square portrait", square],
    ["tall picture", tall],
  ] as const) {
    for (const [cw, ch] of SIZES) {
      it(`${name} ${cw}x${ch}: the whole picture is visible, contained and centred`, () => {
        const i = at(base, cw, ch, 0);
        const v = fullViewport(i);
        const p = picture(i, v);
        expect(p.x0).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y0).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x1).toBeLessThanOrEqual(cw + 1e-6);
        expect(p.y1).toBeLessThanOrEqual(ch + 1e-6);
        expect(p.x0).toBeCloseTo(cw - p.x1, 6);
        expect(p.y0).toBeCloseTo(ch - p.y1, 6);
        // One side touches the canvas, unless the picture is being held
        // back from blurring.
        if (v.scale < MAX_UPSCALE) expect(Math.min(p.x0, p.y0)).toBeCloseTo(0, 6);
        expect(viewportFor(i)).toEqual(v);
      });
    }
  }
});

describe("zoom between", () => {
  it("is the face at 1, the whole picture at 0, and in proportion between", () => {
    const i = at(tall, 600, 600, 0.5);
    const face = faceViewport({ ...i, zoom: 1 }),
      full = fullViewport({ ...i, zoom: 0 });
    const half = viewportFor(i);
    expect(half.scale).toBeCloseTo((face.scale + full.scale) / 2, 9);
    expect(half.offsetY).toBeCloseTo((face.offsetY + full.offsetY) / 2, 9);
    expect(viewportFor({ ...i, zoom: 1 })).toEqual(face);
    // Past the end of the range: the end of the range.
    expect(viewportFor({ ...i, zoom: 7 })).toEqual(viewportFor({ ...i, zoom: 1.3 }));
    expect(viewportFor({ ...i, zoom: -1 })).toEqual(full);
    expect(viewportFor({ ...i, zoom: Number.NaN })).toEqual(face);
  });
});

describe("closer in, and panned", () => {
  it("zoom 1.3 draws the face view 1.6 times larger, the eyes still on the line", () => {
    const face = faceViewport(at(tall, 600, 600, 1));
    const close = viewportFor(at(tall, 600, 600, 1.3));
    expect(close.scale).toBeCloseTo(Math.min(face.scale * 1.6, MAX_UPSCALE), 9);
    expect((tall.eyeY * close.scale + close.offsetY) / 600).toBeCloseTo(EYE_LINE, 6);
    // Still covering the canvas.
    const p = picture(at(tall, 600, 600, 1.3), close);
    expect(p.x0).toBeLessThanOrEqual(0);
    expect(p.x1).toBeGreaterThanOrEqual(600);
    expect(p.y0).toBeLessThanOrEqual(0);
    expect(p.y1).toBeGreaterThanOrEqual(600);
    expect(viewportFor(at(tall, 600, 600, 9)).scale).toBeCloseTo(close.scale, 9);
  });

  it("a pan moves the view, the picture the other way, as a fraction of the canvas", () => {
    const i = at(tall, 600, 600, 1);
    const still = faceViewport(i);
    const right = faceViewport({ ...i, pan: { x: 0.1, y: 0 } });
    const down = faceViewport({ ...i, pan: { x: 0, y: 0.1 } });
    expect(right.offsetX).toBeCloseTo(still.offsetX - 60, 6);
    expect(right.scale).toBe(still.scale);
    expect(down.offsetY).toBeCloseTo(still.offsetY - 60, 6);
    // Further than the picture allows: as far as it allows.
    const far = faceViewport({ ...i, pan: { x: 0.9, y: 0 } });
    expect(far.offsetX).toBeCloseTo(600 - tall.imageW * still.scale, 6);
  });

  it("a pan stops where the picture would stop covering the canvas", () => {
    const i = at(tall, 300, 400, 1);
    const far = faceViewport({ ...i, pan: { x: 1, y: 1 } });
    const p = picture({ ...i, pan: { x: 1, y: 1 } }, far);
    expect(p.x1).toBeCloseTo(300, 6);
    expect(p.y1).toBeCloseTo(400, 6);
    const back = faceViewport({ ...i, pan: { x: -1, y: -1 } });
    const q = picture({ ...i, pan: { x: -1, y: -1 } }, back);
    expect(q.x0).toBeCloseTo(0, 6);
    expect(q.y0).toBeCloseTo(0, 6);
  });

  it("on the whole picture a pan slides it within the canvas, never out of it", () => {
    const i = at(tall, 600, 600, 0);
    const still = fullViewport(i);
    const moved = fullViewport({ ...i, pan: { x: 1, y: 1 } });
    // Tall picture in a square canvas: room beside it, none above or below.
    expect(moved.offsetX).toBeCloseTo(0, 6);
    expect(moved.offsetY).toBeCloseTo(still.offsetY, 6);
    const p = picture(i, moved);
    expect(p.x0).toBeGreaterThanOrEqual(-1e-6);
    expect(p.x1).toBeLessThanOrEqual(600 + 1e-6);
  });

  it("ignores a pan that is not a number", () => {
    const i = at(tall, 600, 600, 1);
    expect(faceViewport({ ...i, pan: { x: Number.NaN, y: Number.POSITIVE_INFINITY } })).toEqual(faceViewport(i));
  });
});

describe("the eye line", () => {
  it("is the mean height of the eye corners, and falls back into the face box without them", () => {
    const y = eyeLine(rig.points, rig.face_box);
    expect(y).toBeGreaterThan(rig.face_box[1]);
    expect(y).toBeLessThan((rig.face_box[1] + rig.face_box[3]) / 2);
    expect(eyeLine([], [0, 100, 100, 300])).toBeCloseTo(170, 9);
  });
});
