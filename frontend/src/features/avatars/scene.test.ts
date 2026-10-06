/**
 * The scene's pure helpers, without a browser: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampScene,
  engineScene,
  isCutOut,
  normalizeHex,
  panned,
  panStepped,
  sameScene,
  sceneErrorKey,
  sceneOf,
  SWATCHES,
  ZOOM_MAX,
  zoomPreset,
  zoomText,
} from "./scene.ts";

describe("sceneOf", () => {
  it("reads the saved scene, and falls back to the framing for an avatar from before", () => {
    assert.deepEqual(sceneOf({ framing: "full" }), {
      zoom: 0,
      pan: { x: 0, y: 0 },
      background: { kind: "transparent" },
    });
    assert.deepEqual(sceneOf({ framing: "face" }), {
      zoom: 1,
      pan: { x: 0, y: 0 },
      background: { kind: "transparent" },
    });
    assert.equal(sceneOf(null).zoom, 1);
    const saved = sceneOf({
      framing: "full",
      scene: {
        zoom: 1.2,
        pan: { x: 0.25, y: -0.5 },
        background: { kind: "color", color: "#1E3A8A", has_image: false },
      },
    });
    assert.deepEqual(saved, { zoom: 1.2, pan: { x: 0.25, y: -0.5 }, background: { kind: "color", color: "#1e3a8a" } });
  });
});

describe("clampScene", () => {
  it("keeps the numbers inside the ranges the API accepts, rounded", () => {
    const clamped = clampScene({ zoom: 7, pan: { x: -3, y: 0.123456 }, background: { kind: "transparent" } });
    assert.equal(clamped.zoom, ZOOM_MAX);
    assert.deepEqual(clamped.pan, { x: -1, y: 0.123 });
    assert.equal(clampScene({ zoom: Number.NaN, pan: { x: 0, y: 0 }, background: { kind: "transparent" } }).zoom, 0);
  });
  it("gives a colour background a colour, and drops a colour from the others", () => {
    assert.equal(
      clampScene({ zoom: 1, pan: { x: 0, y: 0 }, background: { kind: "color", color: "nope" } }).background.color,
      SWATCHES[4].hex
    );
    assert.equal(
      clampScene({ zoom: 1, pan: { x: 0, y: 0 }, background: { kind: "image", color: "#ffffff" } }).background.color,
      undefined
    );
  });
});

describe("colours", () => {
  it("normalizes #rrggbb and refuses the rest", () => {
    assert.equal(normalizeHex(" #ABCDEF "), "#abcdef");
    assert.equal(normalizeHex("#abc"), null);
    assert.equal(normalizeHex("red"), null);
  });
  it("offers eight distinct valid swatches, each with a name", () => {
    assert.equal(SWATCHES.length, 8);
    assert.equal(new Set(SWATCHES.map((s) => s.hex)).size, 8);
    for (const swatch of SWATCHES) {
      assert.equal(normalizeHex(swatch.hex), swatch.hex);
      assert.match(swatch.nameKey, /^sceneSwatch/);
    }
  });
});

describe("the engine's scene", () => {
  it("names the picture by its URL, and shows nothing when there is none yet", () => {
    const draft = { zoom: 0.5, pan: { x: 0.1, y: 0 }, background: { kind: "image" as const } };
    assert.deepEqual(engineScene(draft, "https://x/bg.webp").background, {
      kind: "image",
      image_url: "https://x/bg.webp",
    });
    assert.deepEqual(engineScene(draft, null).background, { kind: "transparent" });
    assert.deepEqual(engineScene({ ...draft, background: { kind: "color", color: "#112233" } }, null).background, {
      kind: "color",
      color: "#112233",
    });
  });
});

describe("zoom", () => {
  it("knows the presets and words the rest as a percentage of the face view", () => {
    assert.equal(zoomPreset(1), "face");
    assert.equal(zoomPreset(0), "full");
    assert.equal(zoomPreset(0.5), null);
    assert.deepEqual(zoomText(1), { key: "sceneZoomFaceValue", percent: 100 });
    assert.deepEqual(zoomText(0), { key: "sceneZoomFullValue", percent: 0 });
    assert.deepEqual(zoomText(0.5), { key: "sceneZoomPercent", percent: 50 });
    assert.deepEqual(zoomText(1.3), { key: "sceneZoomPercent", percent: 160 });
  });
});

describe("pan", () => {
  it("moves the view the other way from a drag, as a fraction of the surface, clamped", () => {
    assert.deepEqual(panned({ x: 0, y: 0 }, 50, -25, 200, 100), { x: -0.25, y: 0.25 });
    assert.deepEqual(panned({ x: 0.9, y: 0 }, -100, 0, 200, 100), { x: 1, y: 0 });
    assert.deepEqual(panned({ x: 0.3, y: 0.3 }, 10, 10, 0, 0), { x: 0.3, y: 0.3 });
  });
  it("steps with the arrow keys, further with Shift, and ignores other keys", () => {
    assert.deepEqual(panStepped({ x: 0, y: 0 }, "ArrowRight", false), { x: 0.05, y: 0 });
    assert.deepEqual(panStepped({ x: 0, y: 0 }, "ArrowUp", true), { x: 0, y: -0.2 });
    assert.deepEqual(panStepped({ x: -0.98, y: 0 }, "ArrowLeft", false), { x: -1, y: 0 });
    assert.equal(panStepped({ x: 0, y: 0 }, "Enter", false), null);
  });
});

describe("the rest", () => {
  it("compares scenes by value", () => {
    const a = { zoom: 1, pan: { x: 0, y: 0 }, background: { kind: "color" as const, color: "#ffffff" } };
    assert.equal(sameScene(a, { ...a, pan: { x: 0, y: 0 } }), true);
    assert.equal(sameScene(a, { ...a, background: { kind: "color", color: "#000000" } }), false);
  });
  it("only a cut-out shows a background", () => {
    assert.equal(isCutOut({ original_image_key: "k" }), true);
    assert.equal(isCutOut({ original_image_key: null }), false);
    assert.equal(isCutOut(null), false);
  });
  it("words the API's refusals", () => {
    assert.equal(sceneErrorKey("image_too_large"), "sceneErrImageLarge");
    assert.equal(sceneErrorKey("scene_image_missing"), "sceneErrImageMissing");
    assert.equal(sceneErrorKey("something_else"), null);
  });
});
