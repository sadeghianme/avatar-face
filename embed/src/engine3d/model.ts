/**
 * What the 3D engine finds in a model and how it moves it: the meshes that
 * carry morph targets, the head and neck nodes, where the camera stands,
 * and the influences written on every frame.
 */
import * as THREE from "three";

import { MORPH_NAMES, morphIndex } from "./visemes";

/** A mesh with morph targets: its name -> index table and its influences. */
export interface MorphMesh {
  mesh: THREE.Mesh;
  dictionary: Record<string, number>;
  influences: number[];
}

export interface ModelParts {
  /** Every mesh with morph targets (head, teeth, eyes...), in tree order. */
  morphMeshes: MorphMesh[];
  /** The first node named like a head (not a "head top" end bone), if any. */
  headBone: THREE.Object3D | null;
  /** The first node named like a neck, if any. */
  neckBone: THREE.Object3D | null;
  /** Whether a mesh carries the Ready Player Me viseme targets; without
   *  them the visemes are decomposed into ARKit blendshapes. */
  visemeMorphs: boolean;
}

/** What `model` offers the engine, found in one walk of its tree. */
export function findModelParts(model: THREE.Object3D): ModelParts {
  const parts: ModelParts = { morphMeshes: [], headBone: null, neckBone: null, visemeMorphs: false };
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
      parts.morphMeshes.push({
        mesh,
        dictionary: mesh.morphTargetDictionary as Record<string, number>,
        influences: mesh.morphTargetInfluences,
      });
      if ("viseme_aa" in mesh.morphTargetDictionary) parts.visemeMorphs = true;
    }
    const lower = object.name.toLowerCase();
    if (!parts.headBone && lower.includes("head") && !lower.includes("top")) parts.headBone = object;
    if (!parts.neckBone && lower.includes("neck")) parts.neckBone = object;
  });
  return parts;
}

/** Where the camera looks, if the model says: a centre and a visible
 *  height, model units. */
export interface FrameSpec { center: [number, number, number]; height: number }

/**
 * Stand `camera` before `model`. A frame the model gives is taken as it is;
 * otherwise head-and-shoulders on the head node, or, for a boneless face
 * shell from the GLB generator, closer in on the centre of its bounds.
 */
export function frameCamera(
  camera: THREE.PerspectiveCamera,
  model: THREE.Object3D,
  headBone: THREE.Object3D | null,
  spec: FrameSpec | undefined
): void {
  model.updateWorldMatrix(true, true);
  if (spec) {
    const centre = new THREE.Vector3(...spec.center);
    const distance = (spec.height / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera.position.set(centre.x, centre.y, centre.z + distance);
    camera.lookAt(centre);
    return;
  }
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const target = new THREE.Vector3();
  if (headBone) {
    headBone.getWorldPosition(target);
    target.y += size.y * 0.01;
  } else {
    box.getCenter(target);
  }
  const distance = headBone
    ? Math.max(size.x, size.y * 0.35) * 1.9 + 0.25
    : Math.max(size.x, size.y) * 1.35 + 0.12;
  camera.position.set(target.x, target.y + 0.02, target.z + distance);
  camera.lookAt(target);
}

/** One frame's morph influences, for every mesh alike. */
export interface MorphFrame {
  /** Targets held by name for a still, or null for the speech to drive. */
  held: Readonly<Record<string, number>> | null;
  /** Every speech-driven target name a still rests (the visemes and the
   *  decomposition's ARKit names). */
  speechNames: readonly string[];
  /** The ARKit values of the decomposition, or null on the viseme path. */
  arkit: Readonly<Record<string, number>> | null;
  /** The viseme morphs' weights. */
  visemes: Readonly<Record<string, number>>;
  /** How closed the lids are. */
  blink: number;
  /** The eyeLook* values. */
  look: Readonly<Record<string, number>>;
  /** The inner brows' lift. */
  brow: number;
}

/** Write `frame` into every mesh's influences: the mouth (held, ARKit or
 *  visemes), the lids, the gaze and the brows. A mesh without a target
 *  simply does not take it. */
export function applyMorphs(meshes: readonly MorphMesh[], frame: MorphFrame): void {
  for (const { dictionary, influences } of meshes) {
    if (frame.held) {
      // A still: the speech-driven targets rest, the held ones are set.
      for (const name of frame.speechNames) {
        const index = morphIndex(dictionary, name);
        if (index !== undefined) influences[index] = 0;
      }
      for (const [name, value] of Object.entries(frame.held)) {
        const index = morphIndex(dictionary, name);
        if (index !== undefined) influences[index] = value;
      }
    } else if (frame.arkit) {
      for (const name of Object.keys(frame.arkit)) {
        const index = morphIndex(dictionary, name);
        if (index !== undefined) influences[index] = frame.arkit[name];
      }
    } else {
      for (const name of MORPH_NAMES) {
        const index = dictionary[name];
        if (index !== undefined) influences[index] = frame.visemes[name];
      }
    }
    for (const lid of ["eyeBlinkLeft", "eyeBlinkRight"]) {
      const index = morphIndex(dictionary, lid);
      if (index !== undefined) influences[index] = frame.blink;
    }
    for (const [name, value] of Object.entries(frame.look)) {
      const index = morphIndex(dictionary, name);
      if (index !== undefined) influences[index] = value;
    }
    const brow = dictionary["browInnerUp"];
    if (brow !== undefined) influences[brow] = frame.brow;
  }
}

/** Set `names` to 0 on every mesh that has them (a held target released). */
export function clearMorphs(meshes: readonly MorphMesh[], names: Iterable<string>): void {
  for (const name of names) {
    for (const { dictionary, influences } of meshes) {
      const index = morphIndex(dictionary, name);
      if (index !== undefined) influences[index] = 0;
    }
  }
}
