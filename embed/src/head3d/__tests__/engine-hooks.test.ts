import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar3DEngine, type Avatar3DOptions, type HeadPose } from "../../engine3d";
import { morphModel, stubCanvas, stubRenderer } from "../../engine3d/__tests__/three-fakes";
import { engine3dSeam } from "../../engine3d/seam";
import type { Cue } from "../../types";

/**
 * The hooks the 3D engine grew for head3d, and the promise that without
 * them it is the engine it was: the built-in viseme decomposition, the
 * default lights, the frame from the bounds, the sum-of-sines idle head.
 * Driven through the engine's public API (step, playCues, holdMorphs); the
 * camera is read through its seam.
 */

const ARKIT = [
  "jawOpen",
  "mouthClose",
  "mouthPucker",
  "mouthFunnel",
  "mouthStretchLeft",
  "mouthStretchRight",
  "eyeBlinkLeft",
];
const VISEMES = ["viseme_sil", "viseme_aa", "viseme_PP"];

const CUES: Cue[] = [
  { t: 0, viseme: "aa", a: 1 },
  { t: 5000, viseme: "aa", a: 1 },
];

/** The lights the engine put in the scene it added the model to. */
const lightsOf = (model: THREE.Object3D) =>
  (model.parent?.children ?? []).filter((c) => (c as THREE.Light).isLight) as THREE.Light[];

describe("the 3D engine's options", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineWith = (morphs: string[], options?: Avatar3DOptions) => {
    const m = morphModel(morphs);
    const { renderer, render } = stubRenderer({ calls: 7, triangles: 1600 });
    const engine = new Avatar3DEngine(stubCanvas(), m.root, renderer, options);
    return { engine, render, ...m };
  };
  const frames = (engine: Avatar3DEngine, ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      engine.step(now);
    }
  };
  const speak = (engine: Avatar3DEngine, ms: number) => {
    engine.playCues(CUES);
    frames(engine, ms);
  };

  it("drives the model's own viseme table instead of the built-in decomposition", () => {
    const own = { aa: { jawOpen: 0.5, mouthPucker: 0.4 }, sil: {} };
    const { engine, influence } = engineWith(ARKIT, { visemes: own });
    speak(engine, 600);
    // The cue track reaches aa at 0.85; the table says half a jaw and a pucker.
    expect(influence("jawOpen")).toBeCloseTo(0.85 * 0.5, 2);
    expect(influence("mouthPucker")).toBeCloseTo(0.85 * 0.4, 2);
    expect(influence("mouthStretchLeft")).toBe(0); // the built-in aa had stretch; the own table has none
    engine.destroy();
  });

  it("keeps the built-in decomposition without a table", () => {
    const { engine, influence } = engineWith(ARKIT);
    speak(engine, 600);
    expect(influence("jawOpen")).toBeCloseTo(0.85 * 0.85, 2);
    expect(influence("mouthStretchLeft")).toBeCloseTo(0.85 * 0.2, 2);
    engine.destroy();
  });

  it("lights as asked, and as before when not asked", () => {
    const { engine, root } = engineWith(ARKIT, { lights: { hemisphere: 2.5, key: 0.6, groundColor: 0x102030 } });
    const lights = lightsOf(root);
    const hemisphere = lights.find((l) => (l as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight;
    const key = lights.find((l) => (l as THREE.DirectionalLight).isDirectionalLight)!;
    expect(hemisphere.intensity).toBe(2.5);
    expect(hemisphere.groundColor.getHex()).toBe(0x102030);
    expect(key.intensity).toBe(0.6);
    engine.destroy();
    const plain = engineWith(ARKIT);
    expect(
      lightsOf(plain.root)
        .map((l) => l.intensity)
        .sort()
    ).toEqual([1.4, 1.6]);
    plain.engine.destroy();
  });

  it("frames what the model says to frame", () => {
    const { engine } = engineWith(ARKIT, { frame: { center: [0.01, 0.02, 0.03], height: 0.3 } });
    const { camera } = engine3dSeam(engine);
    const distance = 0.15 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    expect(camera.position.x).toBeCloseTo(0.01, 9);
    expect(camera.position.y).toBeCloseTo(0.02, 9);
    expect(camera.position.z).toBeCloseTo(0.03 + distance, 9);
    engine.destroy();
  });

  it("lets a driver pose the head, scaled by the head-motion setting", () => {
    const pose: HeadPose = { yaw: 0.3, pitch: -0.1, roll: 0.05 };
    const driver = { update: vi.fn(() => pose) };
    const { engine, head } = engineWith(ARKIT, { headPose: driver });
    frames(engine, 16);
    expect(driver.update).toHaveBeenCalledWith(expect.any(Number), now, false, expect.any(Number));
    expect(head.rotation.y).toBeCloseTo(0.3, 9);
    expect(head.rotation.x).toBeCloseTo(-0.1, 9);
    expect(head.rotation.z).toBeCloseTo(0.05, 9);
    engine.tuning.headMotion = 0.5;
    frames(engine, 16);
    expect(head.rotation.y).toBeCloseTo(0.15, 9);
    engine.destroy();
    // Without a driver the head drifts on its own, as it did.
    const plain = engineWith(ARKIT);
    now += 500;
    plain.engine.step(now);
    expect(plain.head.rotation.y).not.toBe(0);
    plain.engine.destroy();
  });

  it("holds named morphs for a still and hands the mouth back to speech", () => {
    const { engine, influence } = engineWith([...ARKIT, ...VISEMES]);
    engine.holdMorphs({ viseme_aa: 1, jawOpen: 0.3 });
    speak(engine, 600);
    expect(influence("viseme_aa")).toBe(1);
    expect(influence("jawOpen")).toBe(0.3);
    expect(influence("viseme_PP")).toBe(0); // the speech-driven targets rest
    engine.holdMorphs(null);
    speak(engine, 600);
    expect(influence("viseme_aa")).toBeGreaterThan(0.5); // RPM visemes drive again
    expect(influence("jawOpen")).toBe(0); // and the ARKit path is not in use for this model
    engine.destroy();
  });

  it("steps one frame on demand and reports the frame's cost", () => {
    const { engine, render } = engineWith(ARKIT);
    engine.step(now + 16);
    expect(render).toHaveBeenCalledTimes(1);
    expect(engine.stats()).toEqual({ calls: 7, triangles: 1600 });
    engine.destroy();
  });
});
