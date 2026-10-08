import { describe, expect, it } from "vitest";

import { RIGID_SHARE, rigidShare } from "../head-placement";
import { nextScene, startingScene } from "../scene";

/**
 * The policies engine.ts handed to its modules, as rules: how much of the
 * "3d" turn the head's rigid motion carries (head-placement.ts), and how a
 * scene starts and changes (scene.ts). The frames they make are held by
 * the pixel and draw-call goldens; these say what the numbers are.
 */

describe("rigidShare", () => {
  it("a layered head carries half the skull's travel and 40% of the roll", () => {
    expect(rigidShare(true, false)).toEqual({ travel: 0.5, roll: 0.4 });
    // Layered wins over a cut-out: the layers are what moves.
    expect(rigidShare(true, true)).toBe(RIGID_SHARE.layered);
  });

  it("a cut-out's bust leans by half the travel and 30% of the roll", () => {
    expect(rigidShare(false, true)).toEqual({ travel: 0.5, roll: 0.3 });
  });

  it("an opaque photo, moving whole, carries a third of the travel and a fifth of the roll", () => {
    expect(rigidShare(false, false)).toEqual({ travel: 0.35, roll: 0.2 });
  });

  it("is a constant, not an object a frame", () => {
    expect(rigidShare(false, false)).toBe(rigidShare(false, false));
  });
});

describe("startingScene", () => {
  it("takes the zoom given directly over the scene's and the framing's", () => {
    expect(startingScene({ zoom: 0.4 }, 0.8, true).zoom).toBe(0.8);
    expect(startingScene({ zoom: 0.4 }, undefined, true).zoom).toBe(0.4);
  });

  it("falls back to the framing: the whole picture 0, the face 1", () => {
    expect(startingScene(null, undefined, true).zoom).toBe(0);
    expect(startingScene(undefined).zoom).toBe(1);
  });

  it("keeps the scene's pan and background", () => {
    const background = { kind: "color" as const, color: "#204060" };
    expect(startingScene({ pan: { x: 0.1, y: 0 }, background })).toEqual({
      pan: { x: 0.1, y: 0 },
      background,
      zoom: 1,
    });
  });
});

describe("nextScene", () => {
  const prev = { zoom: 0.6, pan: { x: 0.04, y: -0.02 } };

  it("keeps the zoom when the new scene names none", () => {
    expect(nextScene(prev, { pan: prev.pan }).scene.zoom).toBe(0.6);
    expect(nextScene({}, null).scene.zoom).toBe(1);
  });

  it("has moved when the zoom or the pan changed, not for a background alone", () => {
    expect(nextScene(prev, { ...prev, background: { kind: "color", color: "#fff" } }).moved).toBe(false);
    expect(nextScene(prev, { ...prev, zoom: 0.7 }).moved).toBe(true);
    expect(nextScene(prev, { zoom: 0.6, pan: { x: 0.04, y: 0 } }).moved).toBe(true);
    // No pan is the centre.
    expect(nextScene({ zoom: 1 }, { zoom: 1, pan: { x: 0, y: 0 } }).moved).toBe(false);
  });
});
