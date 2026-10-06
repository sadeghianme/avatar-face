import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar3DEngine } from "../../engine3d";
import { stubCanvas, stubImageDecoding, stubRenderer } from "../../engine3d/__tests__/three-fakes";
import { readHead3DExtras } from "../extras";
import { optionsFor } from "../load";

/**
 * The GLB the backend writes loads in three.js as the engine needs it: the
 * node names it finds the head by, the morph target names it drives, the
 * extras the loader reads. The fixture is backend/scripts/
 * build_head3d_fixture.py's synthetic head (no picture, no landmarker).
 */

const glb = readFileSync(new URL("./fixtures/synthetic-head.glb", import.meta.url));

async function loadFixture(): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await loader.parseAsync(buffer, "");
  return gltf.scene;
}

describe("a head3d GLB in three.js", () => {
  beforeEach(() => {
    stubImageDecoding();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads with the hierarchy and targets the engine relies on", async () => {
    const scene = await loadFixture();
    const names = new Set<string>();
    scene.traverse((o) => names.add(o.name));
    for (const name of [
      "Head",
      "Face",
      "Skull",
      "HairCard",
      "Cavity",
      "TeethUpper",
      "TeethLower",
      "Tongue",
      "Neck",
      "Body",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    const head = scene.getObjectByName("Head")!;
    expect(head.getObjectByName("Face")).toBeTruthy();
    expect(head.getObjectByName("Body")).toBeUndefined(); // the body stays still
    expect(head.getObjectByName("Neck")).toBeUndefined(); // so does the neck
    const face = scene.getObjectByName("Face") as THREE.Mesh;
    const dictionary = face.morphTargetDictionary!;
    expect(face.geometry.attributes.position.count).toBe(478);
    for (const name of [
      "jawOpen",
      "mouthClose",
      "mouthPucker",
      "mouthFunnel",
      "mouthStretchLeft",
      "mouthStretchRight",
      "mouthSmileLeft",
      "mouthSmileRight",
      "eyeBlinkLeft",
      "eyeBlinkRight",
      "viseme_sil",
      "viseme_aa",
      "viseme_I",
      "viseme_O",
      "viseme_U",
    ]) {
      expect(dictionary[name], name).toBeDefined();
    }
    expect(Object.keys(dictionary)).toHaveLength(25);
    expect(face.morphTargetInfluences).toHaveLength(25);
    const lower = scene.getObjectByName("TeethLower") as THREE.Mesh;
    expect(Object.keys(lower.morphTargetDictionary!)).toEqual(["jawOpen"]);
    const upper = scene.getObjectByName("TeethUpper") as THREE.Mesh;
    expect(upper.morphTargetDictionary).toBeUndefined();
    const material = face.material as THREE.MeshStandardMaterial;
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.roughness).toBe(1);
    const extras = readHead3DExtras(scene)!;
    expect(extras.kind).toBe("head3d");
    expect(extras.look).toBe("photo");
    expect(extras.visemes.aa.jawOpen).toBe(0.85);
    expect(extras.morphs).toHaveLength(25);
  });

  it("is driven by the engine with its own options", async () => {
    const scene = await loadFixture();
    const extras = readHead3DExtras(scene);
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const engine = new Avatar3DEngine(stubCanvas(), scene, stubRenderer().renderer, optionsFor(extras));
    const face = scene.getObjectByName("Face") as THREE.Mesh;
    engine.playCues([
      { t: 0, viseme: "aa", a: 1 },
      { t: 5000, viseme: "aa", a: 1 },
    ]);
    for (let t = 0; t < 600; t += 16) {
      now += 16;
      engine.step(now);
    }
    // The head has viseme shapes, so the engine drives them, not the ARKit set.
    expect(face.morphTargetInfluences![face.morphTargetDictionary!.viseme_aa]).toBeGreaterThan(0.5);
    expect(face.morphTargetInfluences![face.morphTargetDictionary!.jawOpen]).toBe(0);
    // The skull's skirt and the cavity carry the same shape.
    const skull = scene.getObjectByName("Skull") as THREE.Mesh;
    expect(skull.morphTargetInfluences![skull.morphTargetDictionary!.viseme_aa]).toBeGreaterThan(0.5);
    const head = scene.getObjectByName("Head")!;
    expect(Math.abs(head.rotation.y) + Math.abs(head.rotation.x)).toBeGreaterThan(0); // the idle driver moved it
    engine.destroy();
    vi.restoreAllMocks();
  });
});
