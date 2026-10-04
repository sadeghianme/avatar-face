import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lidEdge, lidAmount, lidSamplePoints, medianColour, regularEye } from "../blink-lid";
import {
  CharacterField,
  DEFAULT_TRAITS,
  INNER_LOWER,
  INNER_UPPER,
  characterOpening,
  edgeWidth,
  tuckAmount,
  mergeTraits,
  mouthFrame,
  sampleLook,
  type Pt,
  type Rgb,
} from "../character-mouth";
import { TONGUE_RAISE, teethHeight, teethShown, tongueColour } from "../character-paint";
import { KNOWN_PROFILES, HUMAN_PROFILE, kindProfile } from "../kind-profile";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../types";

const rig = JSON.parse(
  readFileSync(new URL("./fixtures/fitted-animal-rig.json", import.meta.url), "utf8")
) as Rig;
const base: Pt[] = rig.points.map(([x, y]) => ({ x, y }));
const W = (w: Partial<BlendWeights>): BlendWeights => ({ ...ZERO_WEIGHTS, ...w });
const moved = (w: Partial<BlendWeights>, traits = DEFAULT_TRAITS, gain = 1): Pt[] => {
  const pts = base.map((p) => ({ ...p }));
  new CharacterField(base).apply(pts, W(w), gain, traits);
  return pts;
};
const dy = (a: Pt[], i: number) => a[i].y - base[i].y;

describe("the character mouth's frame", () => {
  it("is the mouth's own corners, centre and tilt", () => {
    const f = mouthFrame(base);
    expect(f.w).toBeCloseTo(400, 0);
    expect(f.ax).toBeCloseTo(1, 3);
    expect(f.ny).toBeCloseTo(1, 3); // down the face
  });
});

describe("the jaw", () => {
  it("does nothing at rest", () => {
    const pts = moved({});
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i].x).toBeCloseTo(base[i].x, 6);
      expect(pts[i].y).toBeCloseTo(base[i].y, 6);
    }
  });

  it("drops the lower lip and the chin, keeps the upper lip and the upper face", () => {
    const pts = moved({ jawOpen: 0.9 });
    const lowerLip = dy(pts, 14);
    const chin = dy(pts, 152);
    expect(lowerLip).toBeGreaterThan(40);
    // The chin travels, but less than the lip does: the lip slides over the jaw.
    expect(chin).toBeGreaterThan(lowerLip * 0.4);
    expect(chin).toBeLessThan(lowerLip);
    // The upper lip lifts a hair, never drops; the nose and the brow stay put.
    expect(dy(pts, 13)).toBeLessThanOrEqual(0);
    expect(dy(pts, 13)).toBeGreaterThan(-lowerLip * 0.3);
    expect(dy(pts, 1)).toBe(0);
    expect(dy(pts, 10)).toBe(0);
  });

  it("takes the corners half way and leaves the cheeks behind", () => {
    const pts = moved({ jawOpen: 0.9 });
    expect(Math.abs(dy(pts, 61))).toBeLessThan(dy(pts, 14) * 0.1);
    // A cheek well beside the mouth, level with it, stays level.
    const cheek = base.findIndex((p, i) => i < 468 && Math.abs(p.y - 690) < 20 && p.x < 180);
    if (cheek >= 0) expect(Math.abs(dy(pts, cheek))).toBeLessThan(2);
  });

  it("scales with the owner's jaw setting and the engine's mouthOpen", () => {
    const one = dy(moved({ jawOpen: 0.8 }), 14);
    expect(dy(moved({ jawOpen: 0.8 }, { ...DEFAULT_TRAITS, jaw: 1.5 }), 14)).toBeCloseTo(one * 1.5, 3);
    expect(dy(moved({ jawOpen: 0.8 }, DEFAULT_TRAITS, 0.5), 14)).toBeCloseTo(one * 0.5, 3);
  });

  it("moves lower lip landmarks in order, so the lip line cannot fold over itself", () => {
    const pts = moved({ jawOpen: 0.9, mouthFunnel: 0.5, mouthPucker: 0.4 });
    for (const ring of [INNER_UPPER, INNER_LOWER]) {
      for (let k = 1; k < ring.length; k++) {
        expect(pts[ring[k]].x).toBeGreaterThanOrEqual(pts[ring[k - 1]].x - 1e-6);
      }
    }
  });

  it("narrows the mouth for a pucker and widens it for a stretch", () => {
    const width = (p: Pt[]) => p[291].x - p[61].x;
    expect(width(moved({ mouthPucker: 0.85 }))).toBeLessThan(width(base) - 40);
    expect(width(moved({ mouthStretch: 0.5 }))).toBeGreaterThan(width(base) + 20);
  });

  it("moves the outer lip rows with the inner ones, not at odds with them", () => {
    // The rows of one lip share a falloff; if they did not, an outer row would
    // spread less than the inner one and the drawn line would crumple.
    const pts = moved({ mouthPucker: 0.85, mouthFunnel: 0.6 });
    const upperRows = [[80, 74, 40], [81, 73, 39], [82, 72, 37]];
    for (const row of upperRows) {
      const shift = row.map((i) => pts[i].x - base[i].x);
      expect(Math.max(...shift) - Math.min(...shift)).toBeLessThan(Math.abs(shift[0]) * 0.2 + 2);
    }
  });
});

describe("the opening", () => {
  it("is not there at rest, and is there on an open vowel", () => {
    expect(characterOpening(moved({}), base)).toBeNull();
    const open = characterOpening(moved({ jawOpen: 0.9 }), base)!;
    expect(open).not.toBeNull();
    expect(open.gap).toBeGreaterThan(60);
    expect(open.alpha).toBe(1);
    expect(open.upper).toHaveLength(INNER_UPPER.length);
  });

  it("opens a little on retraction without the jaw (the sounds that show teeth)", () => {
    const e = characterOpening(moved({ mouthStretch: 0.5, mouthSmile: 0.35 }), base)!;
    expect(e).not.toBeNull();
    expect(e.gap).toBeGreaterThan(5);
    expect(e.gap).toBeLessThan(60);
  });

  it("stays shut for a pucker", () => {
    expect(characterOpening(moved({ mouthPucker: 0.9 }), base)).toBeNull();
  });
});

describe("teeth and tongue", () => {
  it("shows upper teeth for open and retracted mouths, never for a rounded one or a muzzle", () => {
    expect(teethShown(0.3, W({ jawOpen: 0.9 }), DEFAULT_TRAITS)).toBe(1);
    expect(teethShown(0.05, W({ mouthStretch: 0.5 }), DEFAULT_TRAITS)).toBeGreaterThan(0.4);
    expect(teethShown(0.3, W({ jawOpen: 0.6, mouthPucker: 0.5, mouthFunnel: 0.55 }), DEFAULT_TRAITS)).toBe(0);
    expect(teethShown(0.3, W({ jawOpen: 0.9 }), { ...DEFAULT_TRAITS, teeth: "none" })).toBe(0);
  });

  it("makes teeth a band of an open mouth and most of a narrow one", () => {
    expect(teethHeight(200, 400, 1)).toBeLessThanOrEqual(400 * 0.085);
    const narrow = teethHeight(20, 400, 1);
    expect(narrow / 20).toBeGreaterThan(0.55);
  });

  it("raises the tongue for /th/ and /d/, not for a vowel", () => {
    expect(TONGUE_RAISE.TH).toBe(1);
    expect(TONGUE_RAISE.DD).toBeGreaterThan(0.7);
    expect(TONGUE_RAISE.aa).toBeLessThan(0.1);
  });

  it("paints a tongue that is red whatever the lips are, and lighter than the cavity", () => {
    const tan = tongueColour({ flat: true, line: [20, 10, 8], lip: [200, 150, 90], skin: [220, 170, 110] });
    expect(tan[0]).toBeGreaterThan(tan[2] + 40);
    const dark = tongueColour({ flat: true, line: [90, 60, 50], lip: [60, 40, 30], skin: [90, 70, 60] });
    expect(dark[0] + dark[1] + dark[2]).toBeGreaterThan(150);
  });
});

describe("what the mouth takes from the picture", () => {
  const palette = (colours: Rgb[]) => (x: number, y: number): Rgb =>
    colours[(Math.floor(x / 30) + Math.floor(y / 30)) % colours.length];
  const noisy = (x: number, y: number): Rgb => [
    (x * 37 + y * 11) % 256, (x * 7 + y * 53) % 256, (x * 13 + y * 29) % 256,
  ];
  const seam: Pt[] = [{ x: 100, y: 100 }, { x: 140, y: 100 }];
  const box = { cx: 120, cy: 100, w: 40 };

  it("calls a few flat colours cel art, and a spread of colours a render", () => {
    expect(sampleLook(palette([[240, 190, 160], [200, 140, 120], [60, 30, 25]]), seam, box, [150, 90, 80], [240, 190, 160]).flat).toBe(true);
    expect(sampleLook(noisy, seam, box, [150, 90, 80], [200, 160, 140]).flat).toBe(false);
  });

  it("does not take fur in a narrow range of browns for cel art, nor a smooth gradient", () => {
    // Few palette bins, but the pixels are never the same as their neighbours.
    const fur = (x: number, y: number): Rgb => {
      const n = ((x * 73 + y * 151) % 17) - 8;
      return [150 + n, 112 + n, 80 + n];
    };
    expect(sampleLook(fur, seam, box, [150, 90, 80], [150, 112, 80]).flat).toBe(false);
    const shaded = (x: number): Rgb => [200 + x * 0.6, 150 + x * 0.6, 130 + x * 0.6];
    expect(sampleLook(shaded, seam, box, [150, 90, 80], [200, 150, 130]).flat).toBe(false);
  });

  it("reads how soft the picture's edges are, and feathers by that", () => {
    const edge = (blur: number) => (_x: number, y: number): Rgb => {
      const t = blur < 0.1 ? (y > 100 ? 1 : 0) : Math.max(0, Math.min(1, (y - 100) / blur + 0.5));
      const v = 240 - 200 * t;
      return [v, v, v];
    };
    const crisp = edgeWidth(edge(0.01), seam)!;
    const soft = edgeWidth(edge(4), seam)!;
    expect(crisp).toBeLessThan(1.2);
    expect(soft).toBeGreaterThan(crisp * 2);
    expect(sampleLook(edge(4), seam, box, [150, 90, 80], [200, 160, 140]).soft).toBeGreaterThan(
      sampleLook(edge(0.01), seam, box, [150, 90, 80], [200, 160, 140]).soft
    );
    expect(edgeWidth(() => [200, 200, 200], seam)).toBeNull();
  });

  it("takes the line from the darkest tone on the mouth's own seam", () => {
    const pixel = (_x: number, y: number): Rgb => (y === 101 ? [30, 14, 12] : [240, 190, 160]);
    expect(sampleLook(pixel, seam, box, [150, 90, 80], [240, 190, 160]).line).toEqual([30, 14, 12]);
  });

  it("copes with a picture it cannot read", () => {
    const look = sampleLook(() => null, seam, box, [150, 90, 80], [200, 160, 140]);
    expect(look.flat).toBe(false);
    expect(look.line).toHaveLength(3);
  });
});

describe("the owner's mouth settings", () => {
  it("clamp the jaw, ignore nonsense and keep the profile's own where unsaid", () => {
    expect(mergeTraits(DEFAULT_TRAITS, { jaw: 9 }).jaw).toBe(1.6);
    expect(mergeTraits(DEFAULT_TRAITS, { jaw: 0 }).jaw).toBe(0.5);
    expect(mergeTraits(DEFAULT_TRAITS, { jaw: Number.NaN }).jaw).toBe(1);
    expect(mergeTraits(DEFAULT_TRAITS, { teeth: "fangs" as never }).teeth).toBe("upper");
    expect(mergeTraits(DEFAULT_TRAITS, { teeth: "none", tongue: false })).toEqual({ teeth: "none", tongue: false, jaw: 1 });
    expect(mergeTraits(DEFAULT_TRAITS, null)).toBe(DEFAULT_TRAITS);
  });
});

describe("render profile selection", () => {
  it("knows the character profiles, and only they use the character mouth", () => {
    expect(KNOWN_PROFILES).toEqual(expect.arrayContaining(["animal@1", "toon@1", "animal@2"]));
    expect(kindProfile({ render_profile: "toon@1" }).mouth).toBe("character");
    expect(kindProfile({ render_profile: "animal@2" }).mouth).toBe("character");
    expect(kindProfile({ render_profile: "animal@1" }).mouth).toBe("classic");
    expect(kindProfile({ render_profile: null })).toBe(HUMAN_PROFILE);
    expect(HUMAN_PROFILE.mouth).toBe("classic");
    expect(HUMAN_PROFILE.blink).toBe("mesh");
  });

  it("gives a muzzle no incisors and a wider jaw than a toon", () => {
    expect(kindProfile({ render_profile: "animal@2" }).traits.teeth).toBe("none");
    expect(kindProfile({ render_profile: "toon@1" }).traits.teeth).toBe("upper");
    expect(kindProfile({ render_profile: "animal@2" }).traits.jaw).toBeGreaterThan(1);
  });
});

describe("the painted lid", () => {
  const eye = {
    upper: [{ x: 0, y: 10 }, { x: 10, y: 4 }, { x: 20, y: 2 }, { x: 30, y: 4 }, { x: 40, y: 10 }],
    lower: [{ x: 0, y: 10 }, { x: 10, y: 15 }, { x: 20, y: 17 }, { x: 30, y: 15 }, { x: 40, y: 10 }],
  };

  it("comes down from the upper lid to the lower one, corners fixed", () => {
    const open = lidEdge(eye, 0);
    const shut = lidEdge(eye, 1);
    expect(Math.abs(open[2].y - eye.upper[2].y)).toBeLessThan(1.5); // smoothed a little
    expect(shut[2].y).toBeGreaterThanOrEqual(eye.lower[2].y - 0.5);
    expect(Math.abs(shut[0].y - eye.lower[0].y)).toBeLessThan(3);
    const half = lidEdge(eye, 0.5);
    expect(half[2].y).toBeGreaterThan(open[2].y);
    expect(half[2].y).toBeLessThan(shut[2].y);
  });

  it("is open at no blink and shut at the peak, and is read from skin beside the eye", () => {
    expect(lidAmount(0)).toBe(0);
    expect(lidAmount(1)).toBe(1);
    const points = lidSamplePoints(eye.upper, eye.lower);
    expect(points.some((p) => p.y < 2)).toBe(true); // above the lid
    expect(points.some((p) => p.y > 17)).toBe(true); // below the lower lid
  });

  it("prefers the lighter skin to the shadow round the eye", () => {
    const samples: Rgb[] = [[100, 70, 60], [200, 150, 130], [210, 160, 140], [90, 60, 50], [205, 155, 135]];
    const c = medianColour(samples, 0.7)!;
    expect(c[0]).toBeGreaterThan(190);
    expect(medianColour([null, null])).toBeNull();
  });

  it("builds the lid on a smooth eye, however loose the marks are", () => {
    // Marks jittered by several px, one of them far off the eye.
    const loose = {
      upper: [{ x: 0, y: 10 }, { x: 10, y: 7 }, { x: 20, y: -9 }, { x: 30, y: 1 }, { x: 40, y: 10 }],
      lower: [{ x: 0, y: 10 }, { x: 10, y: 21 }, { x: 20, y: 13 }, { x: 30, y: 20 }, { x: 40, y: 10 }],
    };
    for (const e of [eye, loose]) {
      const r = regularEye(e);
      expect(r.upper[0]).toEqual({ x: 0, y: 10 });
      expect(r.upper[r.upper.length - 1].x).toBeCloseTo(40);
      // Each lid is one arch (up, then down), and the eye is a plausible size.
      const ups = r.upper.map((p) => p.y);
      const peak = ups.indexOf(Math.min(...ups));
      for (let i = 1; i <= peak; i++) expect(ups[i]).toBeLessThanOrEqual(ups[i - 1] + 1e-6);
      for (let i = peak + 1; i < ups.length; i++) expect(ups[i]).toBeGreaterThanOrEqual(ups[i - 1] - 1e-6);
      const height = Math.max(...r.lower.map((p) => p.y)) - Math.min(...ups);
      expect(height).toBeGreaterThan(40 * 0.14);
      expect(height).toBeLessThan(40 * 0.95);
    }
    // The wild mark does not drag the lid out of the eye's own size.
    expect(Math.min(...regularEye(loose).upper.map((p) => p.y))).toBeGreaterThan(-6);
  });
});

describe("/f/ and /v/", () => {
  it("are told from /p/, /th/ and the vowels", () => {
    const w = (o: Partial<BlendWeights>) => ({ ...ZERO_WEIGHTS, ...o });
    expect(tuckAmount(w({ jawOpen: 0.1, mouthClose: 0.55, mouthStretch: 0.25, mouthFunnel: 0.1 }))).toBeGreaterThan(0.7);
    expect(tuckAmount(w({ jawOpen: 0.12, mouthClose: 0.5, mouthStretch: 0.15 }))).toBeGreaterThan(0.5);
    expect(tuckAmount(w({ jawOpen: 0.05, mouthClose: 0.9, mouthPucker: 0.25 }))).toBe(0); // /p/
    expect(tuckAmount(w({ jawOpen: 0.25, mouthClose: 0.2, mouthStretch: 0.2 }))).toBe(0); // /th/
    expect(tuckAmount(w({ jawOpen: 0.85, mouthStretch: 0.2 }))).toBe(0); // /aa/
    expect(tuckAmount(ZERO_WEIGHTS)).toBe(0);
  });

  it("close a muzzle to one seam, and leave a toon's teeth a tooth's height of opening", () => {
    const ff = rig.visemes.FF;
    const opening = (traits: typeof DEFAULT_TRAITS) => characterOpening(moved(ff, traits), base);
    expect(opening({ ...DEFAULT_TRAITS, teeth: "none" })).toBeNull();
    const toon = opening({ ...DEFAULT_TRAITS, teeth: "upper" });
    expect(toon).not.toBeNull();
    expect(toon!.gap / toon!.width).toBeGreaterThan(0.03);
    expect(toon!.gap / toon!.width).toBeLessThan(0.14);
  });
});
