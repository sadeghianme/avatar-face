import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar3DEngine, type Avatar3DOptions, type HeadPose } from "../../engine3d";
import type { Cue } from "../../types";

/**
 * The hooks the 3D engine grew for head3d, and the promise that without
 * them it is the engine it was: the built-in viseme decomposition, the
 * default lights, the frame from the bounds, the sum-of-sines idle head.
 */

const ARKIT = ["jawOpen", "mouthClose", "mouthPucker", "mouthFunnel", "mouthStretchLeft", "mouthStretchRight", "eyeBlinkLeft"];
const VISEMES = ["viseme_sil", "viseme_aa", "viseme_PP"];

/** A model with ARKit morphs (or RPM viseme morphs) and a Head node. */
function model(morphs: string[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.morphTargetDictionary = Object.fromEntries(morphs.map((name, i) => [name, i]));
  mesh.morphTargetInfluences = morphs.map(() => 0);
  const head = new THREE.Group();
  head.name = "Head";
  head.add(mesh);
  const root = new THREE.Group();
  root.add(head);
  const influence = (name: string) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]];
  return { root, head, influence };
}

const renderer = {
  setPixelRatio() {}, setSize() {}, dispose() {},
  render: vi.fn(),
  info: { render: { calls: 7, triangles: 1600 } },
} as unknown as THREE.WebGLRenderer;

type Internals = { tick(now: number): void; scene: THREE.Scene; camera: THREE.PerspectiveCamera };

const CUES: Cue[] = [{ t: 0, viseme: "aa", a: 1 }, { t: 5000, viseme: "aa", a: 1 }];

describe("the 3D engine's options", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    (renderer.render as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const canvas = () => ({ width: 256, height: 256, dataset: {} } as unknown as HTMLCanvasElement);
  const engineWith = (morphs: string[], options?: Avatar3DOptions) => {
    const m = model(morphs);
    const engine = new Avatar3DEngine(canvas(), m.root, renderer, options);
    return { engine, e: engine as unknown as Internals, ...m };
  };
  const speak = (engine: Avatar3DEngine, e: Internals, ms: number) => {
    engine.playCues(CUES);
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      e.tick(now);
    }
  };

  it("drives the model's own viseme table instead of the built-in decomposition", () => {
    const own = { aa: { jawOpen: 0.5, mouthPucker: 0.4 }, sil: {} };
    const { engine, e, influence } = engineWith(ARKIT, { visemes: own });
    speak(engine, e, 600);
    // The cue track reaches aa at 0.85; the table says half a jaw and a pucker.
    expect(influence("jawOpen")).toBeCloseTo(0.85 * 0.5, 2);
    expect(influence("mouthPucker")).toBeCloseTo(0.85 * 0.4, 2);
    expect(influence("mouthStretchLeft")).toBe(0); // the built-in aa had stretch; the own table has none
    engine.destroy();
  });

  it("keeps the built-in decomposition without a table", () => {
    const { engine, e, influence } = engineWith(ARKIT);
    speak(engine, e, 600);
    expect(influence("jawOpen")).toBeCloseTo(0.85 * 0.85, 2);
    expect(influence("mouthStretchLeft")).toBeCloseTo(0.85 * 0.2, 2);
    engine.destroy();
  });

  it("lights as asked, and as before when not asked", () => {
    const { engine, e } = engineWith(ARKIT, { lights: { hemisphere: 2.5, key: 0.6, groundColor: 0x102030 } });
    const lights = e.scene.children.filter((c) => (c as THREE.Light).isLight) as THREE.Light[];
    const hemisphere = lights.find((l) => (l as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight;
    const key = lights.find((l) => (l as THREE.DirectionalLight).isDirectionalLight)!;
    expect(hemisphere.intensity).toBe(2.5);
    expect(hemisphere.groundColor.getHex()).toBe(0x102030);
    expect(key.intensity).toBe(0.6);
    engine.destroy();
    const plain = engineWith(ARKIT);
    const defaults = plain.e.scene.children.filter((c) => (c as THREE.Light).isLight) as THREE.Light[];
    expect(defaults.map((l) => l.intensity).sort()).toEqual([1.4, 1.6]);
    plain.engine.destroy();
  });

  it("frames what the model says to frame", () => {
    const { engine, e } = engineWith(ARKIT, { frame: { center: [0.01, 0.02, 0.03], height: 0.3 } });
    const distance = 0.15 / Math.tan(THREE.MathUtils.degToRad(e.camera.fov) / 2);
    expect(e.camera.position.x).toBeCloseTo(0.01, 9);
    expect(e.camera.position.y).toBeCloseTo(0.02, 9);
    expect(e.camera.position.z).toBeCloseTo(0.03 + distance, 9);
    engine.destroy();
  });

  it("lets a driver pose the head, scaled by the head-motion setting", () => {
    const pose: HeadPose = { yaw: 0.3, pitch: -0.1, roll: 0.05 };
    const driver = { update: vi.fn(() => pose) };
    const { engine, e, head } = engineWith(ARKIT, { headPose: driver });
    now += 16;
    e.tick(now);
    expect(driver.update).toHaveBeenCalledWith(expect.any(Number), now, false, expect.any(Number));
    expect(head.rotation.y).toBeCloseTo(0.3, 9);
    expect(head.rotation.x).toBeCloseTo(-0.1, 9);
    expect(head.rotation.z).toBeCloseTo(0.05, 9);
    engine.tuning.headMotion = 0.5;
    now += 16;
    e.tick(now);
    expect(head.rotation.y).toBeCloseTo(0.15, 9);
    engine.destroy();
    // Without a driver the head drifts on its own, as it did.
    const plain = engineWith(ARKIT);
    now += 500;
    plain.e.tick(now);
    expect(plain.head.rotation.y).not.toBe(0);
    plain.engine.destroy();
  });

  it("holds named morphs for a still and hands the mouth back to speech", () => {
    const { engine, e, influence } = engineWith([...ARKIT, ...VISEMES]);
    engine.holdMorphs({ viseme_aa: 1, jawOpen: 0.3 });
    speak(engine, e, 600);
    expect(influence("viseme_aa")).toBe(1);
    expect(influence("jawOpen")).toBe(0.3);
    expect(influence("viseme_PP")).toBe(0); // the speech-driven targets rest
    engine.holdMorphs(null);
    speak(engine, e, 600);
    expect(influence("viseme_aa")).toBeGreaterThan(0.5); // RPM visemes drive again
    expect(influence("jawOpen")).toBe(0); // and the ARKit path is not in use for this model
    engine.destroy();
  });

  it("steps one frame on demand and reports the frame's cost", () => {
    const { engine } = engineWith(ARKIT);
    engine.step(now + 16);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(engine.stats()).toEqual({ calls: 7, triangles: 1600 });
    engine.destroy();
  });
});
