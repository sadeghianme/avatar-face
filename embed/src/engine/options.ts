/**
 * What a page may ask of an AvatarEngine when it makes one (engine.ts):
 * the options, and the head motion's two modes. Types only.
 */
import type { MouthExtension, MouthPose } from "../mouth-extension";
import type { FaceType } from "../types";
import type { WarpMode } from "./mesh-warp";
import type { Scene } from "./scene";

/** EngineOptions.headMotion. */
export type HeadMotionMode = "2d" | "3d";

export interface EngineOptions {
  debugMesh?: boolean;
  /**
   * Put this engine on `globalThis.__liveface` for the console and for
   * measurement scripts (the last engine made wins); `destroy()` takes it
   * back. Off by default, so a customer's page gets no globals from the
   * engine: the widget turns it on with `data-debug` on its script tag or
   * `?liveface-debug` in the page's URL (debug-handle.ts).
   */
  debug?: boolean;
  /** Optional mouth renderer (see mouth/). Omitted means the classic mouth. */
  mouthExtension?: MouthExtension;
  pose?: () => MouthPose | null;
  /** Opt-in lab clock, in audio milliseconds. Omitted by all existing pages. */
  cueClock?: () => number;
  /**
   * The "full" framing: the whole picture, contained and centred. Without
   * it (or with `zoom` 1) the "face" framing: the picture composed as a
   * portrait that fills the canvas. Either way the whole picture is drawn;
   * the two are zoom levels of one viewport (viewport.ts).
   */
  fullPhoto?: boolean;
  /** The zoom directly: 1 the face, 0 the whole picture, between in
   *  proportion, up to 1.3 closer in. Wins over `scene.zoom` and `fullPhoto`. */
  zoom?: number;
  /** The scene the avatar is shown in (zoom, pan, background): what the
   *  owner set and published. `setScene` changes it live. */
  scene?: Scene | null;
  /**
   * How the mesh is warped: "auto" (the default) draws it on the GPU
   * (warp-gl.ts) wherever WebGL works and in 2D everywhere else; "2d"
   * forces the Canvas 2D path, for tests and for comparing the two.
   */
  warp?: WarpMode;
  /**
   * Move a cut-out's head (a picture with a transparent background, no
   * published layers) as its own feathered layer over the still body,
   * instead of the whole picture as one (the default). For comparison
   * only: the layer's feathered band shows as a boundary through the hair,
   * the neck and the shoulders whenever the head moves (render2d.ts).
   * `setCutOutHeadLayer` switches it live. Layered avatars and opaque
   * pictures are unaffected.
   */
  cutOutHeadLayer?: boolean;
  /**
   * How the head moves. "3d", the default for a person (faceType "human"):
   * the face turns in depth inside the mesh, about a pivot between the ears
   * (head-turn.ts), the hair, the ears and the head's outline with it
   * (head-field.ts), at most 9 degrees of yaw, 5 of pitch and 3 of roll,
   * with a procedural personality (head-personality.ts); the head's rigid
   * motion (the layer, the whole picture, a cut-out's bust) carries a share
   * of it (head-placement.ts). "2d", the default for an animal or a
   * cartoon: as a rigid layer, shifted and rolled a few pixels
   * (render2d.ts), with nods on the speech's beats. Without a faceType the
   * rig's render profile decides (kind-profile.ts defaultHeadMotion: none,
   * "3d"; toon@1, animal@1, animal@2, "2d"). Either may be asked for;
   * `setHeadMotion` switches it live, and the widget's `data-head-motion`
   * sets it.
   */
  headMotion?: HeadMotionMode;
  /**
   * What the avatar is: its owner's face type, as the API serves it with
   * the avatar ("human", "animal" or "cartoon"). It chooses the head
   * motion's default (headMotion above), which the rig alone cannot: a rig
   * fitted before render profiles existed names none, an animal's or a
   * cartoon's included. Omitted (a host from before it was passed), the
   * rig's profile chooses, as it always did.
   */
  faceType?: FaceType | null;
}
