/**
 * Load a head3d GLB into the existing 3D engine.
 *
 * The GLB's extras carry the rig's viseme table, its look and where to
 * frame; this turns them into the engine's options — the same engine, the
 * same speech controller, the same blink and gaze — and adds the idle head
 * motion. A GLB without the extras loads as any other model would.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { Avatar3DEngine, type Avatar3DOptions } from "../engine3d";
import { expandVisemeTable, readHead3DExtras, type Head3DExtras } from "./extras";
import { IdleHeadPose } from "./head-pose";
import { lightsFor } from "./lighting";

export interface LoadedHead3D {
  engine: Avatar3DEngine;
  extras: Head3DExtras | null;
  scene: THREE.Group;
}

/** The engine options a head3d scene asks for (none for another model). */
export function optionsFor(extras: Head3DExtras | null, overrides: Avatar3DOptions = {}): Avatar3DOptions {
  if (!extras) return { ...overrides };
  return {
    visemes: expandVisemeTable(extras.visemes),
    lights: lightsFor(extras.look),
    frame: extras.frame,
    headPose: new IdleHeadPose(),
    ...overrides,
  };
}

export async function loadHead3D(
  canvas: HTMLCanvasElement,
  url: string,
  overrides: Avatar3DOptions = {},
  renderer?: THREE.WebGLRenderer
): Promise<LoadedHead3D> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const extras = readHead3DExtras(gltf.scene);
  const engine = new Avatar3DEngine(canvas, gltf.scene, renderer, optionsFor(extras, overrides));
  return { engine, extras, scene: gltf.scene };
}
