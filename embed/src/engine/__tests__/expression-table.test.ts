import { describe, expect, it } from "vitest";

import {
  ALIASES,
  ANIMAL_GAINS,
  EXPRESSION_NAMES,
  EXPRESSIONS,
  HUMAN_GAINS,
  REGION_CAP,
  REGION_SPECS,
  REGIONS,
  SHAPE_NAMES,
  TOON_GAINS,
  expressionNamed,
  regionOf,
  type RegionKey,
} from "../expression-table";
import { HUMAN_PROFILE, kindProfile } from "../kind-profile";
import { LANDMARK_COUNT } from "../landmarks";

/** The expressions as data (expression-table.ts): every name has a shape,
 *  every key names a real region, every displacement within its cap. */
describe("the expression table", () => {
  it("has a shape for every name the API takes, and the idle flash", () => {
    for (const name of SHAPE_NAMES) expect(EXPRESSIONS[name]).toBeDefined();
    expect(SHAPE_NAMES).toEqual([...EXPRESSION_NAMES, "browFlash"]);
    expect(Object.keys(EXPRESSIONS.neutral.regions)).toEqual([]);
  });

  it("names only real regions and sides", () => {
    for (const name of SHAPE_NAMES) {
      for (const key of Object.keys(EXPRESSIONS[name].regions) as RegionKey[]) {
        const { region, sides } = regionOf(key);
        expect(REGIONS).toContain(region);
        expect(sides.length).toBeGreaterThan(0);
        for (const side of sides) expect(["left", "right"]).toContain(side);
      }
    }
    expect(regionOf("browOuter.right")).toEqual({ region: "browOuter", sides: ["right"] });
    expect(regionOf("cheek")).toEqual({ region: "cheek", sides: ["left", "right"] });
  });

  it("keeps every expression at 1 inside its regions' caps (a photo's limit)", () => {
    for (const name of SHAPE_NAMES) {
      for (const [key, v] of Object.entries(EXPRESSIONS[name].regions) as [RegionKey, readonly [number, number]][]) {
        expect(Math.hypot(v[0], v[1]), `${name} ${key}`).toBeLessThanOrEqual(REGION_CAP[regionOf(key).region] + 1e-9);
      }
    }
  });

  it("is asymmetric only where it means to be: thinking", () => {
    const sided = SHAPE_NAMES.filter((n) => Object.keys(EXPRESSIONS[n].regions).some((k) => k.includes(".")));
    expect(sided).toEqual(["thinking"]);
    expect(EXPRESSIONS.thinking.gaze).toBeDefined();
    expect(EXPRESSIONS.surprised.jaw).toBeGreaterThan(0);
  });

  it("anchors every region on real landmarks, with a reach", () => {
    for (const region of REGIONS) {
      const spec = REGION_SPECS[region];
      expect(spec.reach).toBeGreaterThan(0);
      for (const side of spec.anchors) {
        expect(side.length).toBeGreaterThan(0);
        for (const i of side) expect(i).toBeLessThan(LANDMARK_COUNT);
      }
    }
  });

  it("reads names and aliases in any case, and nothing else", () => {
    expect(expressionNamed("Happy")).toBe("happy");
    expect(expressionNamed(" SMILE ")).toBe("happy");
    expect(expressionNamed("sad")).toBe("concerned");
    expect(expressionNamed("angry")).toBe("serious");
    expect(expressionNamed("sic")).toBeNull();
    expect(expressionNamed("browFlash")).toBeNull();
    for (const target of Object.values(ALIASES)) expect(EXPRESSION_NAMES).toContain(target);
  });

  it("gives each line of faces its gains", () => {
    expect(HUMAN_PROFILE.expression).toBe(HUMAN_GAINS);
    expect(kindProfile({ render_profile: "toon@1" }).expression).toBe(TOON_GAINS);
    expect(kindProfile({ render_profile: "animal@2" }).expression).toBe(ANIMAL_GAINS);
    expect(kindProfile({ render_profile: "animal@1" }).expression).toBe(ANIMAL_GAINS);
    for (const region of REGIONS) expect(ANIMAL_GAINS[region]).toBeLessThan(1);
  });
});
