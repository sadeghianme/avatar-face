/**
 * The crop rectangle's geometry: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CropRect,
  dragTo,
  fitRatio,
  KEY_MIN_SIDE,
  KEY_STEP,
  keyed,
  pixelSize,
  tooSmall,
  withRatio,
} from "./crop.ts";

const R: CropRect = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

describe("dragging the rectangle", () => {
  it("moves by how far the pointer went, sliding along an edge rather than shrinking", () => {
    const drag = { kind: "move" as const, grabX: 0.4, grabY: 0.4, start: R };
    const moved = dragTo(drag, { x: 0.5, y: 0.3 }, null, null);
    near(moved.x, 0.3);
    near(moved.y, 0.1);
    assert.deepEqual({ w: moved.w, h: moved.h }, { w: 0.5, h: 0.5 });
    assert.deepEqual(dragTo(drag, { x: 1, y: 1 }, null, null), { ...R, x: 0.5, y: 0.5 });
  });

  it("resizes from the handle held, the opposite corner still", () => {
    const se = dragTo({ kind: "resize", handle: "se", start: R }, { x: 0.9, y: 0.8 }, null, null);
    near(se.x, 0.2);
    near(se.y, 0.2);
    near(se.w, 0.7);
    near(se.h, 0.6);
    const n = dragTo({ kind: "resize", handle: "n", start: R }, { x: 0, y: 0.1 }, null, null);
    near(n.x, 0.2);
    near(n.w, 0.5);
    near(n.y, 0.1);
    near(n.h, 0.6);
  });

  it("a handle dragged past the opposite edge turns the rectangle over instead of inverting it", () => {
    const flipped = dragTo({ kind: "resize", handle: "w", start: R }, { x: 0.9, y: 0 }, null, null);
    near(flipped.x, 0.7);
    near(flipped.w, 0.2);
  });

  it("held to an aspect, in pixels: a square on a 2:1 picture is half as wide as tall in fractions", () => {
    const natural = { w: 2000, h: 1000 };
    const square = dragTo({ kind: "resize", handle: "se", start: R }, { x: 0.45, y: 0.9 }, 1, natural);
    near(square.w, 0.25);
    near(square.h, 0.5);
  });
});

describe("an aspect", () => {
  it("keeps the anchor named still and never leaves the picture", () => {
    const natural = { w: 1000, h: 1000 };
    const bottom = withRatio({ x: 0.1, y: 0.5, w: 0.4, h: 0.2 }, 1, natural, false, true);
    near(bottom.h, 0.4);
    near(bottom.y + bottom.h, 0.7);
    const clipped = withRatio({ x: 0, y: 0.8, w: 0.6, h: 0.1 }, 1, natural, false, false);
    near(clipped.y + clipped.h, 1);
  });

  it("chosen, fits the rectangle's height to its width; none leaves it as it is", () => {
    const natural = { w: 1000, h: 1000 };
    const wide = fitRatio(R, 16 / 9, natural);
    near(wide.w, 0.5);
    near(wide.h, 0.5 / (16 / 9));
    assert.equal(fitRatio(R, null, natural), R);
    assert.equal(fitRatio(R, 1, null), R);
  });
});

describe("the keys", () => {
  it("an arrow moves the rectangle one step; with Shift it resizes from the right and bottom", () => {
    const right = keyed(R, "ArrowRight", false, null, null)!;
    near(right.x, R.x + KEY_STEP);
    near(right.w, R.w);
    const taller = keyed(R, "ArrowDown", true, null, null)!;
    near(taller.h, R.h + KEY_STEP);
    near(taller.y, R.y);
  });

  it("stop at the picture's edge and at the smallest side a key may leave", () => {
    const corner = { x: 0, y: 0, w: 0.3, h: 0.3 };
    assert.deepEqual(keyed(corner, "ArrowLeft", false, null, null), corner);
    const small = { x: 0.1, y: 0.1, w: KEY_MIN_SIDE, h: 0.3 };
    near(keyed(small, "ArrowLeft", true, null, null)!.w, KEY_MIN_SIDE);
  });

  it("any other key is not the rectangle's", () => {
    assert.equal(keyed(R, "Enter", false, null, null), null);
  });
});

describe("what the rectangle says", () => {
  it("is too small under the server's smallest side", () => {
    assert.equal(tooSmall(R), false);
    assert.equal(tooSmall({ ...R, w: 0.1 }), true);
  });

  it("is so many image pixels, once the picture's size is known", () => {
    assert.equal(pixelSize(R, { w: 1000, h: 800 }), "500 × 400");
    assert.equal(pixelSize(R, null), "");
  });
});
