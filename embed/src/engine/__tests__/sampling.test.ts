import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LOOK } from "../../character-mouth";
import { FACE_OVAL } from "../../face-light";
import { HUMAN_PROFILE, kindProfile } from "../../kind-profile";
import type { Rig } from "../../types";
import { paintedImage, readingCanvas, type PaintedImage, type Pixel } from "../../__tests__/browser-fakes";
import { CHEEK_LANDMARKS, UPPER_LIDS } from "../landmarks";
import { FaceSamples, luma, pickScleraColour, probeCutOut, type Sample } from "../sampling";

/**
 * What the picture looks like (sampling.ts), read from synthetic pictures
 * through a canvas that reads back what was drawn: the lips, the cheeks,
 * the lashes, the highlight, the sharpness, the lids, the cut-out probe,
 * and what survives a picture that cannot be read.
 */

const rig = JSON.parse(readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const [W, H] = rig.image_size;
const texPoints = rig.points.map(([x, y]) => ({ x, y }));

const rgb = (p: Pixel) => p.slice(0, 3);
const BACKGROUND: Pixel = [250, 250, 250, 255];
const SKIN: Pixel = [214, 168, 140, 255];
const LIP: Pixel = [170, 70, 75, 255];
const LASH: Pixel = [40, 25, 20, 255];
const GLARE: Pixel = [255, 255, 255, 255];

/** Rig pixels painted one of `colours`: 0 is the background. */
function paintMask(paint: (mask: Uint8Array, disc: (i: number, r: number, v: number) => void) => void): Uint8Array {
  const mask = new Uint8Array(W * H);
  const disc = (index: number, radius: number, value: number) => {
    const [cx, cy] = rig.points[index];
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - cx, y - cy) <= radius) mask[y * W + x] = value;
      }
    }
  };
  paint(mask, disc);
  return mask;
}

/** The face oval filled with `value`, scanline by scanline. */
function fillOval(mask: Uint8Array, value: number): void {
  const poly = FACE_OVAL.map((i) => rig.points[i]);
  for (let y = 0; y < H; y++) {
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[j];
      if ((ay > y) !== (by > y)) xs.push(((bx - ax) * (y - ay)) / (by - ay) + ax);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) mask[y * W + x] = value;
    }
  }
}

const picture = (mask: Uint8Array, colours: Pixel[]): PaintedImage =>
  paintedImage(W, H, (x, y) => colours[mask[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]]);

/** A face: skin in its oval on a white wall, lips, lash lines, cheeks. */
const FACE_MASK = paintMask((mask, disc) => {
  fillOval(mask, 1);
  for (const i of rig.mouth_indices) disc(i, 7, 2);
  for (const lid of UPPER_LIDS) for (const i of lid) disc(i, 4, 3);
  for (const i of CHEEK_LANDMARKS) disc(i, 10, 1);
});
const COLOURS: Pixel[] = [BACKGROUND, SKIN, LIP, LASH, GLARE];
const face = picture(FACE_MASK, COLOURS);

function sampled(texture: HTMLImageElement, profile = HUMAN_PROFILE, into = new FaceSamples()): FaceSamples {
  into.sample(texture, texPoints, rig, profile);
  return into;
}

describe("luma and the sclera", () => {
  it("weighs the channels as Rec. 601 does", () => {
    expect(luma([255, 0, 0])).toBeCloseTo(76.245, 9);
    expect(luma([0, 255, 0])).toBeCloseTo(149.685, 9);
    expect(luma([0, 0, 255])).toBeCloseTo(29.07, 9);
  });

  const sample = (c: [number, number, number]): Sample => ({ lum: luma(c), rgb: c });
  const skin = sample([190, 140, 110]);

  it("picks the brightest neutral beside the iris, never bright skin or dark lash", () => {
    const candidates = [sample([200, 150, 120]), sample([205, 200, 196]), sample([40, 38, 36]), sample([180, 176, 172])];
    expect(pickScleraColour(candidates, skin)).toBe("rgb(205, 200, 196)");
  });

  it("finds none in an eye with no white, rather than painting skin into it", () => {
    expect(pickScleraColour([sample([200, 150, 120]), sample([40, 38, 36])], skin)).toBeNull();
    expect(pickScleraColour([], skin)).toBeNull();
  });

  it("judges by fixed bounds when the skin is unknown", () => {
    expect(pickScleraColour([sample([130, 128, 125])], null)).toBe("rgb(130, 128, 125)");
    expect(pickScleraColour([sample([110, 108, 106])], null)).toBeNull();
  });
});

describe("the picture, sampled", () => {
  beforeEach(() => vi.stubGlobal("document", { createElement: () => readingCanvas() }));
  afterEach(() => vi.unstubAllGlobals());

  it("reads the lips, the cheeks and each eye's lashes where the landmarks are", () => {
    const s = sampled(face);
    expect(s.lipColour).toEqual(rgb(LIP));
    expect(s.skinColour).toEqual(rgb(SKIN));
    expect(s.lashRgb).toEqual([rgb(LASH), rgb(LASH)]);
    expect(s.lashColour).toEqual(["rgba(40, 25, 20, 0.8)", "rgba(40, 25, 20, 0.8)"]);
  });

  it("takes the lips' median, so the skin and the seam either side do not set it", () => {
    // Fifteen of the forty lip landmarks on a white glint.
    const glinted = picture(paintMask((mask, disc) => {
      fillOval(mask, 1);
      rig.mouth_indices.forEach((i, k) => disc(i, 7, k < 15 ? 4 : 2));
    }), COLOURS);
    expect(sampled(glinted).lipColour).toEqual(rgb(LIP));
  });

  it("finds the highlight inside the face, not on the wall behind it", () => {
    expect(sampled(face).faceHighlight).toBeCloseTo(luma(rgb(SKIN) as [number, number, number]), 9);
    // A lit cheek over more than 3% of the face is the highlight.
    const lit = picture(paintMask((mask, disc) => {
      fillOval(mask, 1);
      for (const i of CHEEK_LANDMARKS) disc(i, 60, 4);
    }), COLOURS);
    expect(sampled(lit).faceHighlight).toBeCloseTo(255, 9);
  });

  it("measures a hard-edged picture as sharp, and the look's softness from it", () => {
    const s = sampled(face);
    expect(s.faceSharpness).not.toBeNull();
    expect(s.faceSharpness!).toBeLessThan(1.3);
    const mouthWidth = Math.hypot(texPoints[291].x - texPoints[61].x, texPoints[291].y - texPoints[61].y);
    expect(s.look.soft).toBeCloseTo(s.faceSharpness! / mouthWidth, 9);
    expect(s.look.lip).toEqual(rgb(LIP));
    expect(s.look.skin).toEqual(rgb(SKIN));
  });

  it("gives a flat picture no sharpness and the default softness", () => {
    const s = sampled(paintedImage(W, H, () => SKIN));
    expect(s.faceSharpness).toBeNull();
    expect(s.look.soft).toBe(DEFAULT_LOOK.soft);
    expect(s.lipColour).toEqual(rgb(SKIN));
  });

  it("reads each eye's lid only for a profile that paints one", () => {
    const human = sampled(face);
    expect(human.lidExtent).toEqual([null, null]);
    expect(human.lidTone).toEqual(new FaceSamples().lidTone);
    const toon = sampled(face, kindProfile({ render_profile: "toon@1" }));
    for (let e = 0; e < 2; e++) {
      // The lid's skin is the lighter end of what is around the eye: skin,
      // not the lash line.
      expect(toon.lidTone[e]).toEqual({ above: rgb(SKIN), below: rgb(SKIN) });
      expect(toon.lidExtent[e]).not.toBeNull();
      expect(toon.lidCloneOk[e]).toBe(true);
    }
  });
});

describe("a picture that cannot be read", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves every default in place", () => {
    vi.stubGlobal("document", { createElement: () => readingCanvas(256, { taint: true }) });
    const fresh = new FaceSamples();
    const s = sampled(face);
    expect(s.lipColour).toEqual(fresh.lipColour);
    expect(s.skinColour).toBeNull();
    expect(s.faceHighlight).toBeNull();
    expect(s.faceSharpness).toBeNull();
    expect(s.lashColour).toEqual(fresh.lashColour);
    expect(s.look).toEqual({ ...DEFAULT_LOOK, lip: fresh.lipColour, skin: DEFAULT_LOOK.skin });
  });

  it("keeps the colours a readable one before it gave, but no sharpness: that was in another picture's pixels", () => {
    vi.stubGlobal("document", { createElement: () => readingCanvas() });
    const s = sampled(face);
    const before = { lip: s.lipColour, skin: s.skinColour, highlight: s.faceHighlight, lash: s.lashColour };
    expect(s.faceSharpness).not.toBeNull();
    vi.stubGlobal("document", { createElement: () => readingCanvas(256, { taint: true }) });
    sampled(face, HUMAN_PROFILE, s);
    expect({ lip: s.lipColour, skin: s.skinColour, highlight: s.faceHighlight, lash: s.lashColour }).toEqual(before);
    expect(s.faceSharpness).toBeNull();
    expect(s.look.soft).toBe(DEFAULT_LOOK.soft);
  });
});

describe("probeCutOut", () => {
  afterEach(() => vi.unstubAllGlobals());
  const probe = (picture: PaintedImage, options?: { taint?: boolean; context?: boolean }) => {
    vi.stubGlobal("document", { createElement: () => readingCanvas(32, options) });
    return probeCutOut(picture);
  };
  const CLEAR: Pixel = [0, 0, 0, 0];
  /** Transparent where `clear` says, of a 640 px picture. */
  const cut = (clear: (x: number, y: number) => boolean) => paintedImage(640, 640, (x, y) => (clear(x, y) ? CLEAR : SKIN));

  it("calls a picture with two clear corners a cut-out", () => {
    expect(probe(cut((_x, y) => y < 120))).toBe(true); // a head and shoulders: the top clear
    expect(probe(cut((x) => x < 60 || x > 580))).toBe(true);
  });

  it("does not for an opaque picture, or one clear corner (a shoulder may reach the edge)", () => {
    expect(probe(cut(() => false))).toBe(false);
    expect(probe(cut((x, y) => x < 60 && y < 60))).toBe(false);
  });

  it("assumes opaque for a picture it cannot read, and does not know without a canvas", () => {
    expect(probe(cut(() => true), { taint: true })).toBe(false);
    expect(probe(cut(() => true), { context: false })).toBeNull();
  });
});
