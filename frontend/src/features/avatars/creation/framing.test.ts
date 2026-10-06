/**
 * Framing: `npm test` (node --test). Node runs this file as TypeScript by
 * stripping its types, so it imports by file name and uses no syntax that
 * needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anchors, creation, step } from "./fixtures.ts";
import { clampRoll, framingChanged, FULL_FRAME, initialFraming, normalizeCrop } from "./index.ts";

describe("framing", () => {
  const suggested = { crop: { x: 0.1, y: 0.05, w: 0.7, h: 0.6 }, roll: 4.2 };
  const analysed = (extra = {}) =>
    creation({
      analysis: {
        image_size: [800, 1000],
        detector: "mediapipe",
        detected: true,
        face_box: null,
        roll: 4.2,
        suggested_face_type: "human",
        suggested_framing: suggested,
        checks: [],
      },
      ...extra,
    });

  it("opens on the suggestion when nobody has touched the photo", () => {
    assert.deepEqual(initialFraming(analysed()), suggested);
  });
  it("opens on what was applied, once something was", () => {
    const crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    const framed = analysed({
      revision: 3,
      current: "framed",
      steps: [step("original"), step("framed", { from: "original", crop, roll: -2 })],
    });
    assert.deepEqual(initialFraming(framed), { crop, roll: -2 });
  });
  it("keeps the whole photo when the owner moved on without framing", () => {
    assert.deepEqual(initialFraming(analysed({ revision: 2 })), { crop: FULL_FRAME, roll: 0 });
    assert.deepEqual(initialFraming(analysed({ anchors: anchors() })), { crop: FULL_FRAME, roll: 0 });
    assert.deepEqual(initialFraming(creation()), { crop: FULL_FRAME, roll: 0 });
  });
  it("sees a real change, not the server's rounding", () => {
    const a = { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, roll: 0 };
    assert.equal(framingChanged(a, { crop: { x: 0.10004, y: 0.1, w: 0.5, h: 0.5 }, roll: 0.01 }), false);
    assert.equal(framingChanged(a, { crop: { x: 0.12, y: 0.1, w: 0.5, h: 0.5 }, roll: 0 }), true);
    assert.equal(framingChanged(a, { ...a, roll: 1 }), true);
  });
  it("sends crops the server accepts: 4 decimals, inside the photo", () => {
    const crop = normalizeCrop({ x: 0.33333333, y: 0.1, w: 0.66669999, h: 0.9000001 });
    assert.ok(crop.x + crop.w <= 1);
    assert.ok(crop.y + crop.h <= 1);
    assert.equal(crop.x, 0.3333);
    assert.deepEqual(normalizeCrop({ x: -0.01, y: 0, w: 1.02, h: 1 }), FULL_FRAME);
  });
  it("keeps the roll within the API's ±45°", () => {
    assert.equal(clampRoll(50), 45);
    assert.equal(clampRoll(-60), -45);
    assert.equal(clampRoll(3.14159), 3.1);
    assert.equal(clampRoll(Number.NaN), 0);
  });
});
