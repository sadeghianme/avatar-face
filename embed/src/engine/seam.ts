/**
 * The engine's seam: the parts of a live AvatarEngine that code outside it
 * poses and reads one frame at a time, without the frame loop. The tests
 * set the face state and draw a frame, or read what the picture was found
 * to look like; the 3D bake (head3d/bake) records the 2D deformers through
 * it, and the bake's harness draws the 2D engine beside the 3D head.
 *
 * Not the embed's API: no widget imports it, so no bundle carries it, and
 * it changes with the engine.
 *
 * The parts are read by bracket access, which TypeScript checks against the
 * engine's own private members: renaming one fails this file's compile,
 * where a cast in each test would have gone on reading `undefined`.
 */
import type { AvatarEngine } from "../engine";
import type { MouthExtension } from "../mouth-extension";
import type { BlendWeights } from "../types";
import type { FaceMesh, Point } from "./geometry";
import type { MeshWarp } from "./mesh-warp";
import type { Motion } from "./motion";
import type { ClassicMouth } from "./paint-classic-mouth";
import type { FaceSamples } from "./sampling";
import type { Backdrop } from "./scene";
import type { SpeechTrack } from "./speech";
import type { FaceState } from "./state";

export interface EngineSeam {
  /** The face this frame (state.ts): set its weights, blink, gaze or
   *  tongue, then draw. */
  readonly face: FaceState;
  /** What the picture was found to look like (sampling.ts). */
  readonly samples: FaceSamples;
  /** The speech in flight (speech.ts). */
  readonly speech: SpeechTrack;
  /** Blinks, gaze, the head and the body (motion.ts). */
  readonly motion: Motion;
  /** The warped mesh's two paths (mesh-warp.ts). */
  readonly meshWarp: MeshWarp;
  /** The classic drawn mouth (paint-classic-mouth.ts). */
  readonly classicMouth: ClassicMouth;
  /** What is behind a cut-out (scene.ts). */
  readonly backdrop: Backdrop;
  /** The mesh laid on the canvas now: replaced whole by a new texture or
   *  a new viewport, so read it again after either. */
  readonly mesh: FaceMesh;
  /** The texture drawn now. */
  readonly texture: HTMLImageElement;
  /** Whether the picture is a cut-out. */
  readonly cutOut: boolean;
  /** The mouth renderer in charge, if not the classic mouth. */
  readonly mouthExtension: MouthExtension | undefined;
  /** One animation step at frame time `now` (no drawing). */
  tick(now: number): void;
  /** Draw one frame of the face as it is. */
  render(): void;
  /** Every mesh vertex for the face as it is, canvas px. */
  deformedPoints(): Point[];
  /** The cue track's blended shape at frame time `now`. */
  blendedCueWeights(now: number): BlendWeights;
}

/** The seam of `engine`. Live: it reads the engine on every access. */
export function engineSeam(engine: AvatarEngine): EngineSeam {
  return {
    face: engine["face"],
    samples: engine["samples"],
    speech: engine["speech"],
    motion: engine["motion"],
    meshWarp: engine["meshWarp"],
    classicMouth: engine["classicMouth"],
    backdrop: engine["backdrop"],
    get mesh() {
      return engine["mesh"];
    },
    get texture() {
      return engine["texture"];
    },
    get cutOut() {
      return engine["cutOut"];
    },
    get mouthExtension() {
      return engine["mouthExtension"];
    },
    tick: (now) => engine["tick"](now),
    render: () => engine["render"](),
    deformedPoints: () => engine["deformedPoints"](),
    blendedCueWeights: (now) => engine["blendedCueWeights"](now),
  };
}
