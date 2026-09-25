/**
 * The marking canvas's zoom, as geometry: `npm test` (node --test). Node
 * runs this file as TypeScript by stripping its types, so it imports the
 * module by its file name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOUPE_INSET,
  LOUPE_SIZE,
  LOUPE_ZOOM,
  loupeCorner,
  loupeCovers,
  loupeOrigin,
  loupeSize,
  loupeView,
} from "./loupe.ts";

const CANVASES = [
  { width: 640, height: 800 },
  { width: 480, height: 360 },
  { width: 320, height: 400 }, // a phone
  { width: 200, height: 150 },
];

describe("the zoom's size", () => {
  it("is 160 by 120 where there is room", () => {
    assert.deepEqual(loupeSize({ width: 800, height: 1000 }), LOUPE_SIZE);
  });

  it("shrinks on a small canvas, keeping its shape and leaving most of the photo", () => {
    for (const canvas of CANVASES) {
      const size = loupeSize(canvas);
      assert.ok(size.width <= LOUPE_SIZE.width && size.height <= LOUPE_SIZE.height);
      assert.ok(Math.abs(size.width / size.height - 4 / 3) < 1e-9);
      assert.ok(size.width < canvas.width / 2 && size.height < canvas.height / 2, JSON.stringify(canvas));
    }
    // A short wide strip is limited by its height.
    assert.ok(loupeSize({ width: 1000, height: 200 }).height <= 200 * 0.42 + 1e-9);
  });
});

describe("the zoom's corner", () => {
  it("is the one farthest from the pointer", () => {
    const canvas = { width: 640, height: 800 };
    const size = loupeSize(canvas);
    assert.deepEqual(loupeCorner({ x: 50, y: 60 }, canvas, size), { top: false, left: false });
    assert.deepEqual(loupeCorner({ x: 600, y: 760 }, canvas, size), { top: true, left: true });
    assert.deepEqual(loupeCorner({ x: 600, y: 60 }, canvas, size), { top: false, left: true });
    assert.deepEqual(loupeCorner({ x: 50, y: 760 }, canvas, size), { top: true, left: false });
  });

  it("sits inside the photo, inset from its edges", () => {
    const canvas = { width: 640, height: 800 };
    const size = loupeSize(canvas);
    assert.deepEqual(loupeOrigin({ top: true, left: true }, canvas, size), { x: LOUPE_INSET, y: LOUPE_INSET });
    assert.deepEqual(loupeOrigin({ top: false, left: false }, canvas, size), {
      x: 640 - LOUPE_INSET - size.width,
      y: 800 - LOUPE_INSET - size.height,
    });
  });

  it("does not flicker when the pointer rests on the middle", () => {
    const canvas = { width: 640, height: 800 };
    const size = loupeSize(canvas);
    const start = loupeCorner({ x: 330, y: 410 }, canvas, size); // just right of and below the middle
    assert.deepEqual(start, { top: true, left: true });
    // A few pixels back across the middle: it stays.
    assert.deepEqual(loupeCorner({ x: 312, y: 392 }, canvas, size, start), start);
    // Well across: it moves.
    assert.deepEqual(loupeCorner({ x: 200, y: 250 }, canvas, size, start), { top: false, left: false });
  });

  it("never covers the pointer, wherever it goes and however it got there", () => {
    for (const canvas of CANVASES) {
      const size = loupeSize(canvas);
      let previous = null;
      // A pointer sweeping the photo row by row, back and forth: every
      // position is reached with the corner the last one left.
      for (let row = 0; row <= 40; row++) {
        for (let col = 0; col <= 40; col++) {
          const x = ((row % 2 ? 40 - col : col) / 40) * canvas.width;
          const at = { x, y: (row / 40) * canvas.height };
          const corner = loupeCorner(at, canvas, size, previous);
          assert.ok(!loupeCovers(at, corner, canvas, size), `${JSON.stringify({ canvas, at, corner })}`);
          assert.ok(!loupeCovers(at, loupeCorner(at, canvas, size), canvas, size));
          previous = corner;
        }
      }
    }
  });
});

describe("what the zoom shows", () => {
  it("is three times what is on screen, centred on the spot", () => {
    const size = { width: 160, height: 120 };
    // A 2000px photo shown 500px wide: a quarter of a screen pixel each.
    const scale = 0.25;
    const [x, y, w, h] = loupeView({ x: 1000, y: 800 }, scale, size).split(" ").map(Number);
    assert.equal(LOUPE_ZOOM, 3);
    // 160 screen pixels of zoom show 160 / 3 screen pixels of photo, which
    // are 160 / 3 / 0.25 image pixels.
    assert.ok(Math.abs(w - 160 / 3 / scale) < 0.01 && Math.abs(h - 120 / 3 / scale) < 0.01);
    assert.ok(Math.abs(x + w / 2 - 1000) < 0.01 && Math.abs(y + h / 2 - 800) < 0.01);
  });
});
