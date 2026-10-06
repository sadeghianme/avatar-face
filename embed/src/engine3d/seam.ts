/**
 * The 3D engine's seam: the parts of a live Avatar3DEngine that tests read
 * and step one frame at a time, without the frame loop or a GPU. As the 2D
 * engine's (engine/seam.ts): not the embed's API, in no bundle, and read by
 * bracket access so that TypeScript checks every name against the engine's
 * own private members — a rename fails this file's compile instead of a
 * test reading `undefined`.
 */
import type * as THREE from "three";

import type { Voice } from "../engine/voice";
import type { Avatar3DEngine } from "../engine3d";

export interface Engine3DSeam {
  /** The scene the model and the lights are in. */
  readonly scene: THREE.Scene;
  /** The camera the frame is drawn from. */
  readonly camera: THREE.PerspectiveCamera;
  /** The speech in flight (engine/voice.ts): its clock is `cueTime`. */
  readonly speech: Voice;
  /** One animation step at frame time `now`, without drawing. */
  tick(now: number): void;
}

/** The seam of `engine`. */
export function engine3dSeam(engine: Avatar3DEngine): Engine3DSeam {
  return {
    scene: engine["scene"],
    camera: engine["camera"],
    speech: engine["speech"],
    tick: (now) => engine["tick"](now),
  };
}
