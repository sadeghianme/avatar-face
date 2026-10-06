import { describe, expect, it } from "vitest";
import {
  enamelMatch, HIGHLIGHT_HEADROOM, LUMA_FLOOR, MAX_BLUR, OWN_TEETH_STRENGTH, sampleEnamel,
  type EnamelSample, type FaceLook,
} from "../enamel-match-model";
import { cavityReveal, CAVITY_REVEAL, contactSeam, enamelReveal, ENAMEL_REVEAL, REVEAL_RISE_MS, RevealRamp } from "../lip-occlusion-model";
import { faceHighlight, insidePolygon, lumaPercentile } from "../../engine/face-light";

/** The standard teeth, as measured: a warm cream, bright crowns, soft edges
 *  from the photo's upscale to the extraction canvas. */
const STANDARD: EnamelSample = { cast: [1.093, 0.984, 0.922], bright: 227, edge: 8.7 };
const luma = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const warm: FaceLook = { lip: [175, 79, 66], skin: [247, 166, 105], highlight: 207, sharp: 0.027 };
const cool: FaceLook = { lip: [150, 100, 110], skin: [150, 160, 200], highlight: 207, sharp: 0.027 };
const neutral: FaceLook = { lip: [150, 90, 84], skin: [180, 180, 180], highlight: 240, sharp: 0.004 };

describe("the teeth come into the light as the lips part", () => {
  it("shows nothing at a closed mouth and everything once the gap is clear", () => {
    expect(enamelReveal(0, 100)).toBe(0);
    expect(enamelReveal(ENAMEL_REVEAL[0] * 100, 100)).toBe(0);
    expect(enamelReveal(ENAMEL_REVEAL[1] * 100, 100)).toBe(1);
    expect(enamelReveal(30, 100)).toBe(1);
    // The Reference's authored rest has no gap at all: untouched.
    expect(enamelReveal(0, 512)).toBe(0);
    expect(cavityReveal(0, 512)).toBe(0);
    expect(contactSeam(0, 512)).toBe(0);
  });
  it("is continuous and monotone as the mouth opens, and never below the cavity", () => {
    // A lip gap moves well under 0.002 of a mouth width per frame at speech
    // speed; no ramp may step more than its slope over that.
    let previous = 0, previousCavity = 0;
    for (let i = 0; i <= 2000; i++) {
      const gap = i / 2000 * 0.3;
      const reveal = enamelReveal(gap, 1), cavity = cavityReveal(gap, 1);
      expect(reveal).toBeGreaterThanOrEqual(previous);
      expect(reveal - previous).toBeLessThan(0.006);
      expect(cavity).toBeGreaterThanOrEqual(previousCavity);
      expect(cavity - previousCavity).toBeLessThan(0.006);
      expect(cavity).toBeGreaterThanOrEqual(reveal);
      previous = reveal; previousCavity = cavity;
    }
    expect(CAVITY_REVEAL[0]).toBeLessThanOrEqual(ENAMEL_REVEAL[0]);
  });
  it("between words (gap 0.02 to 0.06 of the width) the teeth are mostly hidden", () => {
    for (const gap of [0.02, 0.03, 0.04, 0.05]) expect(enamelReveal(gap, 1)).toBeLessThan(0.3);
    expect(enamelReveal(0.06, 1)).toBeLessThan(0.6);
  });
  it("the contact seam fills the small gaps and hands over to the cavity", () => {
    expect(contactSeam(0.005, 1)).toBe(0);
    expect(contactSeam(0.03, 1)).toBe(1);
    expect(contactSeam(0.2, 1)).toBe(0);
    // Somewhere on the way out, the cavity is already mostly there.
    for (let g = 0.02; g <= 0.12; g += 0.005) expect(contactSeam(g, 1) + cavityReveal(g, 1)).toBeGreaterThan(0.9);
    let previous = contactSeam(0, 1);
    for (let i = 1; i <= 2000; i++) {
      const next = contactSeam(i / 2000 * 0.2, 1);
      expect(Math.abs(next - previous)).toBeLessThan(0.015);
      previous = next;
    }
  });
  it("is nothing for a degenerate mouth", () => {
    expect(enamelReveal(5, 0)).toBe(0);
    expect(enamelReveal(NaN, 100)).toBe(0);
    expect(cavityReveal(5, -1)).toBe(0);
    expect(contactSeam(NaN, 100)).toBe(0);
  });
});

describe("the enamel fitted to the face", () => {
  it("warms toward a warm face and cools toward a cool one, without changing its luma", () => {
    const w = enamelMatch(warm, STANDARD).gain, c = enamelMatch(cool, STANDARD).gain;
    expect(w[0]).toBeGreaterThan(w[2]);
    expect(c[2]).toBeGreaterThan(c[0]);
    expect(w[0] / w[2]).toBeGreaterThan(c[0] / c[2]);
    // The tint alone moves no luma: with no highlight to cap, the gain's luma is 1.
    const tintOnly = enamelMatch({ ...warm, highlight: undefined }, STANDARD).gain;
    expect(luma(tintOnly)).toBeCloseTo(1, 6);
  });
  it("leaves enamel that already has the face's cast alone", () => {
    // The Reference: its teeth photo against its own portrait's cheeks.
    const reference: FaceLook = { lip: [144, 89, 66], skin: [233, 170, 135], highlight: 214, sharp: 0.0113 };
    const { gain, blur } = enamelMatch(reference, STANDARD, true);
    for (const g of gain) expect(Math.abs(g - 1)).toBeLessThan(0.012);
    expect(blur).toBe(0);
  });
  it("caps the crowns a little above the picture's own highlight, never below the floor, never brighter", () => {
    const dim = enamelMatch({ ...neutral, highlight: 150 }, STANDARD);
    const ceiling = 150 * HIGHLIGHT_HEADROOM[0] + HIGHLIGHT_HEADROOM[1];
    expect(luma(dim.gain) * STANDARD.bright).toBeCloseTo(Math.max(ceiling, LUMA_FLOOR * STANDARD.bright), 0);
    const black = enamelMatch({ ...neutral, highlight: 20 }, STANDARD);
    expect(luma(black.gain)).toBeCloseTo(LUMA_FLOOR, 6);
    const bright = enamelMatch({ ...neutral, highlight: 250 }, STANDARD);
    expect(luma(bright.gain)).toBeCloseTo(1, 6);
    // Darker, not greyer: the cap keeps the cream's channel ratios.
    expect(dim.gain[0] / dim.gain[2]).toBeCloseTo(bright.gain[0] / bright.gain[2], 6);
  });
  it("softens the enamel to a soft picture and leaves a crisp one sharp", () => {
    const soft = enamelMatch({ ...neutral, sharp: 0.03 }, STANDARD);
    expect(soft.blur).toBeGreaterThan(1);
    expect(soft.blur).toBeLessThanOrEqual(MAX_BLUR);
    expect(enamelMatch({ ...neutral, sharp: 0.004 }, STANDARD).blur).toBe(0);
    // Teeth already softer than the picture are not softened further.
    expect(enamelMatch({ ...neutral, sharp: 0.03 }, { ...STANDARD, edge: 60 }).blur).toBe(0);
    // Sigmas add in quadrature: a sharper source needs more blur to match.
    expect(enamelMatch({ ...neutral, sharp: 0.03 }, { ...STANDARD, edge: 2 }).blur).toBeGreaterThan(soft.blur);
  });
  it("fits a face's own teeth photo the same way, gently", () => {
    const face: FaceLook = { ...warm, highlight: 150, sharp: 0.03 };
    const standard = enamelMatch(face, STANDARD), own = enamelMatch(face, STANDARD, true);
    expect(own.blur).toBeCloseTo(standard.blur * OWN_TEETH_STRENGTH, 6);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(own.gain[i] - 1)).toBeLessThan(Math.abs(standard.gain[i] - 1));
      expect(Math.sign(own.gain[i] - 1)).toBe(Math.sign(standard.gain[i] - 1));
    }
  });
  it("falls back to the lips, more cautiously, with no skin sample, and to nothing with nothing", () => {
    // Lips redder than the Reference's own warm the enamel; the same lips
    // read as skin would warm it more.
    const lips = enamelMatch({ lip: [190, 70, 60] }, STANDARD);
    const skin = enamelMatch({ lip: [190, 70, 60], skin: [190, 70, 60] }, STANDARD);
    expect(lips.gain[0]).toBeGreaterThan(lips.gain[2]);
    expect(lips.gain[0] / lips.gain[2]).toBeLessThan(skin.gain[0] / skin.gain[2]);
    expect(lips.blur).toBe(0);
    // The Reference's own lips move nothing.
    const reference = enamelMatch({ lip: [144, 89, 66] }, STANDARD);
    for (const g of reference.gain) expect(g).toBeCloseTo(1, 9);
    expect(reference.blur).toBe(0);
    expect(enamelMatch({ lip: [0, 0, 0] }, STANDARD)).toEqual({ gain: [1, 1, 1], blur: 0 });
    expect(enamelMatch({ lip: [NaN, 1, 2] as unknown as [number, number, number], highlight: NaN, sharp: NaN }, { cast: [NaN, 1, 1], bright: NaN, edge: NaN }))
      .toEqual({ gain: [1, 1, 1], blur: 0 });
  });
  it("is deterministic", () => {
    expect(enamelMatch(warm, STANDARD)).toEqual(enamelMatch(warm, STANDARD));
  });
});

describe("the enamel sample", () => {
  it("reads the arch's cast, its brightest crowns and its edge width from the layer", () => {
    const width = 60, height = 30;
    const source = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    const layer = { pixels: { width, height, data: new Uint8ClampedArray(width * height * 4) }, box: { x: 10, y: 8, width: 40, height: 14 } };
    // A cream block of teeth over a dark mouth, with a one-pixel step at its
    // top and bottom: contrast over steepest step is 1 there.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const enamel = y >= 8 && y < 22 && x >= 10 && x < 50;
      source.data.set(enamel ? [230, 210, 190, 255] : [40, 20, 20, 255], k);
      if (enamel) layer.pixels.data.set([230, 210, 190, 255], k);
    }
    const sample = sampleEnamel(layer, source);
    expect(sample.cast[0]).toBeGreaterThan(sample.cast[2]);
    expect(sample.cast[0] * 210).toBeCloseTo(230, 0);
    expect(sample.bright).toBeCloseTo(luma([230, 210, 190]), 0);
    expect(sample.edge).toBe(1);
    expect(sampleEnamel({ ...layer, pixels: { width, height, data: new Uint8ClampedArray(width * height * 4) } }, source))
      .toEqual({ cast: [1, 1, 1], bright: 0, edge: 0 });
  });
});

describe("the face's highlight", () => {
  it("is a high percentile of the luma inside the face oval only", () => {
    // A square face oval, eight points round.
    const oval = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 50, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 50 }];
    expect(insidePolygon(oval, 50, 50)).toBe(true);
    expect(insidePolygon(oval, 150, 50)).toBe(false);
    expect(lumaPercentile([], 0.97)).toBeNull();
    expect(lumaPercentile([10, 20, 30, 40], 0.5)).toBe(30);
    // A 10 x 10 grid over the oval's box, the left half dim and the right half
    // bright, with one glint: the highlight is the bright half's level, not
    // the glint.
    const pixel = (column: number, row: number) => (column === 9 && row === 9 ? [255, 255, 255] : column < 5 ? [60, 60, 60] : [180, 180, 180]);
    expect(faceHighlight(oval, pixel, 10)).toBe(180);
    // Outside the oval nothing counts: a diamond in the same box, bright
    // only in the box's corners, which lie outside it.
    const diamond = [{ x: 50, y: 0 }, { x: 75, y: 25 }, { x: 100, y: 50 }, { x: 75, y: 75 }, { x: 50, y: 100 }, { x: 25, y: 75 }, { x: 0, y: 50 }, { x: 25, y: 25 }];
    const corners = (c: number, r: number) => (Math.abs((c + 0.5) * 10 - 50) + Math.abs((r + 0.5) * 10 - 50) > 60 ? [250, 250, 250] : [100, 100, 100]);
    expect(faceHighlight(diamond, corners, 10)).toBe(100);
    expect(faceHighlight(oval.slice(0, 3), pixel, 10)).toBeNull();
  });
});

describe("a reveal followed over time (RevealRamp)", () => {
  const frame = 1000 / 60;
  it("takes its first value whole: a first frame is not a transition", () => {
    expect(new RevealRamp().step(1, 0)).toBe(1);
    expect(new RevealRamp().step(0.4, frame)).toBe(0.4);
  });
  it("rises over no less than REVEAL_RISE_MS, so teeth never pop on in one frame", () => {
    const ramp = new RevealRamp();
    ramp.step(0, frame);
    const steps: number[] = [];
    let value = 0, elapsed = 0;
    while (value < 1 && elapsed < 1000) {
      value = ramp.step(1, frame);
      elapsed += frame;
      steps.push(value);
    }
    expect(Math.max(...steps.map((v, i) => v - (steps[i - 1] ?? 0)))).toBeLessThanOrEqual(frame / REVEAL_RISE_MS + 1e-9);
    expect(elapsed).toBeGreaterThanOrEqual(REVEAL_RISE_MS - 1e-9);
    expect(elapsed).toBeLessThan(REVEAL_RISE_MS + 2 * frame);
    expect(value).toBe(1);
  });
  it("falls at once: what closing lips cover is covered", () => {
    const ramp = new RevealRamp();
    ramp.step(1, frame);
    expect(ramp.step(0, frame)).toBe(0);
    // And a target under the ramp's own value is taken as it is.
    ramp.step(0.5, frame);
    expect(ramp.step(0.2, frame)).toBe(0.2);
  });
  it("takes the same time at any frame rate, and never overshoots its target", () => {
    const at = (fps: number) => {
      const ramp = new RevealRamp();
      ramp.step(0, 0);
      let value = 0, elapsed = 0;
      while (value < 0.5) { value = ramp.step(0.5, 1000 / fps); elapsed += 1000 / fps; }
      return { value, elapsed };
    };
    expect(at(30).value).toBe(0.5);
    expect(at(120).value).toBe(0.5);
    expect(Math.abs(at(30).elapsed - at(120).elapsed)).toBeLessThan(1000 / 30 + 1e-9);
  });
});
