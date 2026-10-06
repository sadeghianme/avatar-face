import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { blinkEase } from "../../blink";
import { AvatarEngine } from "../../engine";
import { engineSeam } from "../../engine/seam";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";
import { SYMMETRIC_WEIGHTS, bakeMorphTargets, closedBlinkPhase, tableMaxima } from "../bake/bake-morphs";
import { fakeCanvas, installNodeEnvironment } from "../bake/node-env";

/**
 * The bake records the 2D engine's own deformers. These tests hold it to
 * that: a viseme shape applied to the rig's points IS the engine's
 * deformed mesh at that viseme (a round trip through the engine), the
 * symmetric targets move what the engine moves, and the fidelity report
 * says what the linear blend of them gets wrong.
 */

const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;

/** The engine's deformed landmarks at `weights`, in image px. */
function engineShape(source: Rig, weights: Partial<BlendWeights>): { x: number; y: number }[] {
  installNodeEnvironment();
  const [w, h] = source.image_size;
  const image = { naturalWidth: w, naturalHeight: h, width: w, height: h } as HTMLImageElement;
  const engine = new AvatarEngine(fakeCanvas(2048), source, image, { fullPhoto: true });
  const e = engineSeam(engine);
  e.face.weights = { ...ZERO_WEIGHTS, ...weights };
  e.face.blink = 0;
  const base = engine.landmarks();
  const scale = (base[454].x - base[234].x) / (source.points[454][0] - source.points[234][0]);
  const pts = e.deformedPoints().slice(0, 478).map((p, i) => ({
    x: source.points[i][0] + (p.x - base[i].x) / scale,
    y: source.points[i][1] + (p.y - base[i].y) / scale,
  }));
  engine.destroy();
  return pts;
}

describe("baking the 2D deformers", () => {
  const bake = bakeMorphTargets(rig);

  it("records every symmetric target, the blink and every viseme, 478 points each", () => {
    expect(Object.keys(bake.targets).sort()).toEqual([...SYMMETRIC_WEIGHTS, "eyeBlink"].sort());
    expect(Object.keys(bake.visemes).sort()).toEqual(Object.keys(rig.visemes).sort());
    for (const target of [...Object.values(bake.targets), ...Object.values(bake.visemes)]) {
      expect(target.dx).toHaveLength(478);
      expect(target.dy).toHaveLength(478);
      expect(target.dx.every(Number.isFinite) && target.dy.every(Number.isFinite)).toBe(true);
    }
    expect(bake.image_size).toEqual(rig.image_size);
    expect(bake.profile).toBeNull();
    expect(bake.scale).toBeGreaterThan(0);
  });

  it("bakes each weight at the largest value its table asks for", () => {
    const maxima = tableMaxima(rig);
    expect(maxima.jawOpen).toBe(0.85);
    expect(maxima.mouthStretch).toBe(0.5);
    for (const key of SYMMETRIC_WEIGHTS) expect(bake.targets[key].at).toBe(maxima[key]);
    // An unused weight is still baked, at 1.
    const animal = { ...rig, visemes: { aa: { jawOpen: 0.9 }, sil: { mouthClose: 0.1 } } };
    expect(tableMaxima(animal).mouthPucker).toBe(1);
  });

  it("moves what the engine moves: the jaw drops the lower lip and the chin, not the forehead", () => {
    const jaw = bake.targets.jawOpen;
    expect(jaw.dy[14]).toBeGreaterThan(0); // image y down: the inner lower lip drops
    expect(jaw.dy[152]).toBeGreaterThan(0); // the chin follows
    expect(jaw.dy[152]).toBeLessThan(jaw.dy[14]); // by less than the lip
    expect(Math.abs(jaw.dy[13])).toBeLessThan(0.5); // the upper lip stays
    expect(Math.abs(jaw.dy[10])).toBeLessThan(1e-6);
    const stretch = bake.targets.mouthStretch;
    expect(stretch.dx[291]).toBeGreaterThan(0); // the right corner goes right
    expect(stretch.dx[61]).toBeLessThan(0);
  });

  it("bakes the blink at the phase where the lid is lowest", () => {
    const phase = closedBlinkPhase();
    expect(blinkEase(phase)).toBeCloseTo(1, 6);
    const blink = bake.targets.eyeBlink;
    expect(blink.dy[159]).toBeGreaterThan(0); // the upper lid comes down
    expect(blink.dy[386]).toBeGreaterThan(0);
    expect(Math.abs(blink.dy[14])).toBeLessThan(1e-6); // the mouth does not blink
  });

  it("gives back the engine's mesh exactly when a viseme shape is applied whole", () => {
    for (const viseme of ["aa", "ou", "E", "PP"]) {
      const expected = engineShape(rig, rig.visemes[viseme]);
      const shape = bake.visemes[viseme];
      for (let i = 0; i < 478; i++) {
        expect(rig.points[i][0] + shape.dx[i]).toBeCloseTo(expected[i].x, 6);
        expect(rig.points[i][1] + shape.dy[i]).toBeCloseTo(expected[i].y, 6);
      }
    }
  });

  it("measures what a linear blend of the symmetric targets gets wrong", () => {
    for (const [viseme, weights] of Object.entries(rig.visemes)) {
      const { max, mean } = bake.fidelity[viseme];
      expect(mean).toBeGreaterThanOrEqual(0);
      expect(max).toBeGreaterThanOrEqual(mean);
      // Recompute one: the reported error is the error.
      const expected = engineShape(rig, weights);
      const mouthWidth = Math.hypot(rig.points[291][0] - rig.points[61][0], rig.points[291][1] - rig.points[61][1]);
      let worst = 0;
      for (let i = 0; i < 478; i++) {
        let x = rig.points[i][0];
        let y = rig.points[i][1];
        for (const key of SYMMETRIC_WEIGHTS) {
          x += bake.targets[key].dx[i] * (weights[key] ?? 0);
          y += bake.targets[key].dy[i] * (weights[key] ?? 0);
        }
        worst = Math.max(worst, Math.hypot(expected[i].x - x, expected[i].y - y) / mouthWidth);
      }
      expect(worst).toBeCloseTo(max, 5);
    }
    // The rounded vowels are the hard ones for a linear basis: the jaw's
    // lens narrows as the lips round, which no sum of single targets has.
    expect(bake.fidelity.oh.max).toBeGreaterThan(bake.fidelity.aa.max);
    expect(bake.fidelity.oh.max).toBeLessThan(0.1); // under a tenth of a mouth width
  });

  it("bakes the same face the same way, whatever the picture's size or where in it the face sits", () => {
    // A synthetic subject: the fixture's face scaled 1.5x and moved into a
    // larger picture. The deltas are the engine's, in image pixels, so they
    // scale with the face and do not care where it is.
    const s = 1.5;
    const [dx, dy] = [140, 90];
    const moved: Rig = {
      ...rig,
      image_size: [Math.round(rig.image_size[0] * s + 2 * dx), Math.round(rig.image_size[1] * s + 2 * dy)],
      points: rig.points.map(([x, y]) => [x * s + dx, y * s + dy]),
      face_box: [rig.face_box[0] * s + dx, rig.face_box[1] * s + dy, rig.face_box[2] * s + dx, rig.face_box[3] * s + dy],
    };
    const other = bakeMorphTargets(moved);
    const mouthWidth = Math.hypot(rig.points[291][0] - rig.points[61][0], rig.points[291][1] - rig.points[61][1]);
    let worst = 0;
    for (const [name, baked] of [...Object.entries(bake.targets), ...Object.entries(bake.visemes)]) {
      const theirs = other.targets[name] ?? other.visemes[name];
      expect(theirs.at).toBe(baked.at);
      for (let i = 0; i < 478; i++) {
        worst = Math.max(worst, Math.hypot(theirs.dx[i] - baked.dx[i] * s, theirs.dy[i] - baked.dy[i] * s) / (mouthWidth * s));
      }
    }
    expect(worst).toBeLessThan(1e-9); // the same to rounding (measured: 4e-15)
    for (const viseme of Object.keys(bake.fidelity)) {
      expect(other.fidelity[viseme].max).toBeCloseTo(bake.fidelity[viseme].max, 9);
    }
  });

  it("moves nothing at rest and only what each shape touches", () => {
    const rest = bake.visemes.sil;
    // Silence is a closed mouth: the upper face never moves for a mouth shape.
    for (const shape of [...Object.values(bake.visemes), ...SYMMETRIC_WEIGHTS.map((k) => bake.targets[k])]) {
      for (const i of [10, 151, 9, 8, 168, 6, 197]) { // the forehead and the bridge of the nose
        expect(Math.abs(shape.dx[i]) + Math.abs(shape.dy[i])).toBeLessThan(1e-6);
      }
    }
    expect(Math.max(...rest.dy.map(Math.abs))).toBeLessThan(Math.max(...bake.visemes.aa.dy.map(Math.abs)));
  });

  it("bakes a painted-lid profile's blink from the mesh blink", () => {
    const toon = bakeMorphTargets({ ...rig, render_profile: "toon@1" });
    expect(toon.profile).toBe("toon@1");
    expect(toon.targets.eyeBlink.dy[159]).toBeGreaterThan(0);
  });
});
