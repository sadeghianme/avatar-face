import { describe, expect, it } from "vitest";

import type { Cue } from "../../types";
import {
  CUE_PEAK,
  DEFAULT_VISEME_ARKIT,
  MORPH_NAMES,
  VISEME_TO_MORPH,
  arkitNamesOf,
  cueMorphTargets,
  dampMorphs,
  decomposeVisemes,
  morphIndex,
  restingMorphs,
} from "../visemes";

const OCULUS = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"];

const pushed = (targets: Record<string, number>) =>
  Object.fromEntries(Object.entries(targets).filter(([, v]) => v !== 0));

describe("the viseme tables", () => {
  it("name a distinct Ready Player Me target for each of the 15 Oculus visemes", () => {
    expect(Object.keys(VISEME_TO_MORPH).sort()).toEqual([...OCULUS].sort());
    expect(new Set(MORPH_NAMES).size).toBe(15);
    expect(VISEME_TO_MORPH.ih).toBe("viseme_I");
    expect(VISEME_TO_MORPH.oh).toBe("viseme_O");
    expect(VISEME_TO_MORPH.ou).toBe("viseme_U");
  });

  it("decompose every viseme into ARKit weights within (0, 1]", () => {
    expect(Object.keys(DEFAULT_VISEME_ARKIT).sort()).toEqual([...OCULUS].sort());
    for (const weights of Object.values(DEFAULT_VISEME_ARKIT)) {
      for (const value of Object.values(weights)) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // The stretch and the smile are always both sides at once.
    for (const weights of Object.values(DEFAULT_VISEME_ARKIT)) {
      expect(weights.mouthStretchLeft).toBe(weights.mouthStretchRight);
      expect(weights.mouthSmileLeft).toBe(weights.mouthSmileRight);
    }
  });

  it("list each ARKit name a table drives once", () => {
    const names = arkitNamesOf(DEFAULT_VISEME_ARKIT);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([
      "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker",
      "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight",
    ]);
    expect(arkitNamesOf({ aa: { jawOpen: 1 }, oh: { jawOpen: 0.5, mouthFunnel: 0.4 } })).toEqual(["jawOpen", "mouthFunnel"]);
  });
});

describe("finding a morph by name", () => {
  it("takes the name as it is, else the _L/_R suffix convention", () => {
    expect(morphIndex({ mouthSmileLeft: 3 }, "mouthSmileLeft")).toBe(3);
    expect(morphIndex({ mouthSmile_L: 4 }, "mouthSmileLeft")).toBe(4);
    expect(morphIndex({ eyeBlink_R: 5 }, "eyeBlinkRight")).toBe(5);
    expect(morphIndex({ jawOpen: 0 }, "jawOpen")).toBe(0);
    expect(morphIndex({}, "jawOpen")).toBeUndefined();
    // The name as written wins over its alias.
    expect(morphIndex({ mouthSmileLeft: 1, mouthSmile_L: 2 }, "mouthSmileLeft")).toBe(1);
  });
});

describe("the cue track's targets", () => {
  const cues: Cue[] = [
    { t: 100, viseme: "PP" },
    { t: 200, viseme: "aa" },
    { t: 300, viseme: "sil" },
    { t: 500, viseme: "ou" },
  ];

  it("rest before the first cue and on an empty track", () => {
    expect(pushed(cueMorphTargets(cues, 99))).toEqual({});
    expect(pushed(cueMorphTargets([], 1000))).toEqual({});
    expect(Object.keys(cueMorphTargets([], 0)).sort()).toEqual([...MORPH_NAMES].sort());
  });

  it("push the cue in effect and cross-fade linearly into the next", () => {
    expect(pushed(cueMorphTargets(cues, 100))).toEqual({ viseme_PP: CUE_PEAK });
    const mid = cueMorphTargets(cues, 150);
    expect(mid.viseme_PP).toBeCloseTo(CUE_PEAK / 2, 12);
    expect(mid.viseme_aa).toBeCloseTo(CUE_PEAK / 2, 12);
    const late = cueMorphTargets(cues, 175);
    expect(late.viseme_PP).toBeCloseTo(CUE_PEAK * 0.25, 12);
    expect(late.viseme_aa).toBeCloseTo(CUE_PEAK * 0.75, 12);
  });

  it("ask nothing of silence, into it or out of it", () => {
    const closing = cueMorphTargets(cues, 250);
    expect(pushed(closing)).toEqual({ viseme_aa: CUE_PEAK / 2 });
    const opening = cueMorphTargets(cues, 400);
    expect(pushed(opening)).toEqual({ viseme_U: CUE_PEAK / 2 });
  });

  it("hold the last cue, and a cue with no span to the next", () => {
    expect(pushed(cueMorphTargets(cues, 9000))).toEqual({ viseme_U: CUE_PEAK });
    const stacked: Cue[] = [{ t: 0, viseme: "E" }, { t: 0, viseme: "aa" }, { t: 0, viseme: "oh" }];
    expect(pushed(cueMorphTargets(stacked, 0))).toEqual({ viseme_O: CUE_PEAK });
    const unsorted: Cue[] = [{ t: 0, viseme: "E" }, { t: 50, viseme: "aa" }, { t: 50, viseme: "kk" }];
    expect(pushed(cueMorphTargets(unsorted, 60))).toEqual({ viseme_kk: CUE_PEAK });
  });

  it("keep a viseme repeated across two cues at its peak through the fade", () => {
    const same: Cue[] = [{ t: 0, viseme: "aa" }, { t: 100, viseme: "aa" }];
    for (const t of [0, 33, 50, 99]) expect(cueMorphTargets(same, t).viseme_aa).toBeCloseTo(CUE_PEAK, 12);
  });

  it("ignore a viseme the table does not know", () => {
    expect(pushed(cueMorphTargets([{ t: 0, viseme: "zz" }, { t: 100, viseme: "aa" }], 50))).toEqual({ viseme_aa: CUE_PEAK / 2 });
  });
});

describe("damping the morphs toward their targets", () => {
  it("opens by 0.35 of the way per frame and closes by 0.2, at smoothness 1", () => {
    const weights = restingMorphs();
    dampMorphs(weights, { viseme_aa: 0.8 }, 1, 1);
    expect(weights.viseme_aa).toBeCloseTo(0.8 * 0.35, 12);
    const open = { ...restingMorphs(), viseme_aa: 0.8 };
    dampMorphs(open, {}, 1, 1);
    expect(open.viseme_aa).toBeCloseTo(0.8 * 0.8, 12);
  });

  it("scales the rate by smoothness up to 0.6 a frame, and the target by mouthOpen up to 1", () => {
    const fast = restingMorphs();
    dampMorphs(fast, { viseme_aa: 0.5 }, 1, 10);
    expect(fast.viseme_aa).toBeCloseTo(0.5 * 0.6, 12);
    const wide = restingMorphs();
    dampMorphs(wide, { viseme_aa: 0.85 }, 2, 10);
    expect(wide.viseme_aa).toBeCloseTo(1 * 0.6, 12); // 1.7 capped at 1
  });

  it("reports the widest open shape, silence aside", () => {
    const weights = { ...restingMorphs(), viseme_sil: 0.9, viseme_E: 0.3, viseme_aa: 0.5 };
    const jaw = dampMorphs(weights, { viseme_sil: 0.9, viseme_E: 0.3, viseme_aa: 0.5 }, 1, 1);
    expect(jaw).toBeCloseTo(0.5, 12);
  });

  it("converges on a held target", () => {
    const weights = restingMorphs();
    for (let i = 0; i < 200; i++) dampMorphs(weights, { viseme_O: 0.7 }, 1, 1);
    expect(weights.viseme_O).toBeCloseTo(0.7, 9);
  });
});

describe("decomposing the visemes into ARKit values", () => {
  const names = arkitNamesOf(DEFAULT_VISEME_ARKIT);

  it("scales each viseme's weights by how far it is pushed and sums them, capped at 1", () => {
    const weights = { ...restingMorphs(), viseme_aa: 0.5, viseme_O: 0.5 };
    const out = decomposeVisemes(weights, DEFAULT_VISEME_ARKIT, names);
    expect(out.jawOpen).toBeCloseTo(0.85 * 0.5 + 0.6 * 0.5, 12);
    expect(out.mouthPucker).toBeCloseTo(0.5 * 0.5, 12);
    expect(out.mouthStretchLeft).toBeCloseTo(0.2 * 0.5, 12);
    const loud = decomposeVisemes({ ...restingMorphs(), viseme_aa: 1, viseme_O: 1 }, DEFAULT_VISEME_ARKIT, names);
    expect(loud.jawOpen).toBe(1);
  });

  it("gives every name, ignores a viseme under 0.01, and reads an own table", () => {
    const out = decomposeVisemes({ ...restingMorphs(), viseme_aa: 0.009 }, DEFAULT_VISEME_ARKIT, names);
    expect(Object.keys(out).sort()).toEqual([...names].sort());
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
    const own = { aa: { jawOpen: 0.4, cheekPuff: 0.2 } };
    expect(decomposeVisemes({ ...restingMorphs(), viseme_aa: 0.5 }, own, arkitNamesOf(own))).toEqual({ jawOpen: 0.2, cheekPuff: 0.1 });
  });
});
