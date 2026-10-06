import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { HeadBones } from "../head";
import { applyMorphs, clearMorphs, findModelParts, frameCamera, type MorphFrame } from "../model";
import { MORPH_NAMES } from "../visemes";
import { morphModel } from "./three-fakes";

/** A mesh with morph targets named `names`, all at `start`. */
function morphMesh(names: string[], start = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  mesh.morphTargetInfluences = names.map(() => start);
  return mesh;
}

const read = (mesh: THREE.Mesh, name: string) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]];

const still: MorphFrame = {
  held: null, speechNames: [], arkit: null, visemes: {}, blink: 0, look: {}, brow: 0,
};

describe("what the engine finds in a model", () => {
  it("collects the morph meshes in tree order, and the first head and neck", () => {
    const root = new THREE.Group();
    const neck = new THREE.Group();
    neck.name = "Neck";
    const headTop = new THREE.Group();
    headTop.name = "HeadTop_End";
    const head = new THREE.Group();
    head.name = "Head";
    const face = morphMesh(["jawOpen"]);
    const teeth = morphMesh(["viseme_aa"]);
    const plain = new THREE.Mesh(new THREE.BufferGeometry());
    root.add(neck);
    neck.add(headTop, head);
    head.add(face, plain, teeth);
    const parts = findModelParts(root);
    expect(parts.morphMeshes.map((m) => m.mesh)).toEqual([face, teeth]);
    expect(parts.headBone).toBe(head); // not the head's end bone
    expect(parts.neckBone).toBe(neck);
    expect(parts.visemeMorphs).toBe(true);
    expect(parts.morphMeshes[0].influences).toBe(face.morphTargetInfluences);
  });

  it("tells a model without viseme targets, and one without bones", () => {
    const { root } = morphModel(["jawOpen", "mouthClose"], false);
    const parts = findModelParts(root);
    expect(parts.visemeMorphs).toBe(false);
    expect(parts.headBone).toBeNull();
    expect(parts.neckBone).toBeNull();
  });
});

describe("where the camera stands", () => {
  const camera = () => new THREE.PerspectiveCamera(30, 1, 0.01, 50);

  it("takes the model's own frame as it is", () => {
    const c = camera();
    frameCamera(c, new THREE.Group(), null, { center: [0.1, 0.2, 0.3], height: 0.4 });
    const distance = 0.2 / Math.tan(THREE.MathUtils.degToRad(15));
    expect(c.position.toArray()).toEqual([0.1, 0.2, 0.3 + distance]);
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    expect(ahead.z).toBeCloseTo(-1, 12);
  });

  it("frames head and shoulders on the head node, and a boneless shell closer on its centre", () => {
    const { root, head } = morphModel(["jawOpen"]);
    head.position.set(0, 1.6, 0);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.3));
    box.position.set(0, 0.9, 0);
    root.add(box);
    const c = camera();
    frameCamera(c, root, head, undefined);
    // The head plus 1% of the height, the camera 2 cm above it.
    expect(c.position.x).toBeCloseTo(0, 9);
    expect(c.position.y).toBeCloseTo(1.6 + 1.8 * 0.01 + 0.02, 6);
    expect(c.position.z).toBeCloseTo(Math.max(0.4, 1.8 * 0.35) * 1.9 + 0.25, 6); // bounds are float32

    const shell = new THREE.Group();
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.1));
    face.position.set(0.05, 0.1, 0);
    shell.add(face);
    const s = camera();
    frameCamera(s, shell, null, undefined);
    expect(s.position.x).toBeCloseTo(0.05, 6);
    expect(s.position.y).toBeCloseTo(0.1 + 0.02, 6);
    expect(s.position.z).toBeCloseTo(0.3 * 1.35 + 0.12, 6);
  });
});

describe("writing a frame's influences", () => {
  it("drives the viseme targets by their exact names on the viseme path", () => {
    const mesh = morphMesh(["viseme_aa", "viseme_U", "viseme_E_L"]);
    const visemes = Object.fromEntries(MORPH_NAMES.map((n) => [n, 0]));
    visemes.viseme_aa = 0.6;
    visemes.viseme_U = 0.2;
    applyMorphs(findModelParts(mesh).morphMeshes, { ...still, visemes });
    expect(read(mesh, "viseme_aa")).toBe(0.6);
    expect(read(mesh, "viseme_U")).toBe(0.2);
    expect(read(mesh, "viseme_E_L")).toBe(0); // no suffix aliasing for visemes
  });

  it("drives the ARKit values, either suffix convention, on the ARKit path", () => {
    const mesh = morphMesh(["jawOpen", "mouthSmile_L", "mouthSmileRight", "viseme_aa"]);
    applyMorphs(findModelParts(mesh).morphMeshes, {
      ...still,
      arkit: { jawOpen: 0.5, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 },
      visemes: { viseme_aa: 0.9 },
    });
    expect(read(mesh, "jawOpen")).toBe(0.5);
    expect(read(mesh, "mouthSmile_L")).toBe(0.3);
    expect(read(mesh, "mouthSmileRight")).toBe(0.3);
    expect(read(mesh, "viseme_aa")).toBe(0); // the visemes are not written on this path
  });

  it("rests the speech's targets for a still and sets the held ones, whatever else the model has", () => {
    const mesh = morphMesh(["viseme_aa", "viseme_PP", "jawOpen", "cheekPuff"], 0.7);
    applyMorphs(findModelParts(mesh).morphMeshes, {
      ...still,
      held: { viseme_aa: 1, cheekPuff: 0.25 },
      speechNames: [...MORPH_NAMES, "jawOpen"],
      arkit: { jawOpen: 0.9 },
    });
    expect(read(mesh, "viseme_aa")).toBe(1);
    expect(read(mesh, "viseme_PP")).toBe(0);
    expect(read(mesh, "jawOpen")).toBe(0); // the ARKit values do not reach a still
    expect(read(mesh, "cheekPuff")).toBe(0.25);
  });

  it("writes the lids, the gaze and the brows on every path", () => {
    const mesh = morphMesh(["eyeBlinkLeft", "eyeBlink_R", "eyeLookInLeft", "browInnerUp", "browInnerUp_L"]);
    applyMorphs(findModelParts(mesh).morphMeshes, { ...still, blink: 0.8, look: { eyeLookInLeft: 0.1 }, brow: 0.12 });
    expect(read(mesh, "eyeBlinkLeft")).toBe(0.8);
    expect(read(mesh, "eyeBlink_R")).toBe(0.8);
    expect(read(mesh, "eyeLookInLeft")).toBe(0.1);
    expect(read(mesh, "browInnerUp")).toBe(0.12);
    expect(read(mesh, "browInnerUp_L")).toBe(0); // the brows by their one name
  });

  it("clears released targets on every mesh that has them", () => {
    const a = morphMesh(["cheekPuff", "jawOpen"], 0.5);
    const b = morphMesh(["cheekPuff"], 0.5);
    const root = new THREE.Group();
    root.add(a, b);
    clearMorphs(findModelParts(root).morphMeshes, ["cheekPuff", "noSuchTarget"]);
    expect(read(a, "cheekPuff")).toBe(0);
    expect(read(b, "cheekPuff")).toBe(0);
    expect(read(a, "jawOpen")).toBe(0.5);
  });
});

describe("the head and neck nodes", () => {
  const frame = { t: 0, now: 0, dt: 16, speaking: false, energy: 0, nod: 0, headMotion: 1 };

  it("turn by a driver's pose over their rest, scaled, with the nod on the pitch", () => {
    const head = new THREE.Object3D();
    head.rotation.set(0.1, 0.2, 0.3);
    const pose = { yaw: 0.2, pitch: -0.1, roll: 0.05 };
    const calls: unknown[][] = [];
    const bones = new HeadBones(head, null, { update: (...a) => (calls.push(a), pose) });
    bones.update({ ...frame, now: 5, dt: 12, speaking: true, energy: 0.5, nod: 1, headMotion: 0.5 });
    expect(calls).toEqual([[12, 5, true, 0.5]]);
    expect(head.rotation.y).toBeCloseTo(0.2 + 0.1, 12);
    expect(head.rotation.x).toBeCloseTo(0.1 - 0.05 + 0.05 * 0.5, 12);
    expect(head.rotation.z).toBeCloseTo(0.3 + 0.025, 12);
  });

  it("drift within the sum of sines' reach without a driver, more with energy", () => {
    const head = new THREE.Object3D();
    const neck = new THREE.Object3D();
    const bones = new HeadBones(head, neck, null);
    let maxYaw = 0;
    for (let t = 0; t < 120; t += 0.1) {
      bones.update({ ...frame, t, energy: 1 });
      maxYaw = Math.max(maxYaw, Math.abs(head.rotation.y));
      expect(Math.abs(neck.rotation.x)).toBeLessThanOrEqual(0.006 + 1e-12); // the breath
    }
    expect(maxYaw).toBeGreaterThan(0.05);
    expect(maxYaw).toBeLessThanOrEqual(0.09 + 1e-12);
    bones.update({ ...frame, t: 3, headMotion: 0 });
    expect(head.rotation.y).toBe(0);
  });

  it("ask no driver when there is no head to turn", () => {
    const calls: number[] = [];
    const bones = new HeadBones(null, new THREE.Object3D(), { update: () => (calls.push(1), { yaw: 1, pitch: 1, roll: 1 }) });
    bones.update(frame);
    expect(calls).toEqual([]);
  });
});
