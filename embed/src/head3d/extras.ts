/**
 * What a head3d GLB says about itself: the scene's `liveface` extras,
 * written by backend/app/services/head3d/build.py and read here.
 */
import type * as THREE from "three";

import type { BlendWeights } from "../types";

export type Head3DLook = "photo" | "render" | "flat";

export interface Head3DExtras {
  version: number;
  kind: "head3d";
  subject: string;
  look: Head3DLook;
  /** The rig's render profile ("toon@1", "animal@2") or null for the classic human. */
  profile: string | null;
  /** The rig's own viseme table: the six symmetric weights per viseme. */
  visemes: Record<string, Partial<BlendWeights>>;
  /** Where a camera looks and how tall the view is, model units. */
  frame: { center: [number, number, number]; height: number };
  face_width_m: number;
  /** The ARKit morph targets the face carries. */
  morphs: string[];
}

/** The symmetric 2D weights and the ARKit targets each one drives. */
export const SYMMETRIC_TO_ARKIT: Record<keyof BlendWeights, string[]> = {
  jawOpen: ["jawOpen"],
  mouthClose: ["mouthClose"],
  mouthPucker: ["mouthPucker"],
  mouthFunnel: ["mouthFunnel"],
  mouthStretch: ["mouthStretchLeft", "mouthStretchRight"],
  mouthSmile: ["mouthSmileLeft", "mouthSmileRight"],
};

/** The extras of a loaded head3d scene, or null for any other model. */
export function readHead3DExtras(scene: THREE.Object3D): Head3DExtras | null {
  const extras = (scene.userData as { liveface?: Partial<Head3DExtras> }).liveface;
  if (!extras || extras.kind !== "head3d" || !extras.visemes || !extras.frame) return null;
  return {
    version: extras.version ?? 1,
    kind: "head3d",
    subject: extras.subject ?? "",
    look: extras.look === "render" || extras.look === "flat" ? extras.look : "photo",
    profile: extras.profile ?? null,
    visemes: extras.visemes,
    frame: extras.frame,
    face_width_m: extras.face_width_m ?? 0.14,
    morphs: extras.morphs ?? [],
  };
}

/** A viseme -> ARKit weights table from the rig's symmetric one: each
 *  symmetric weight drives both of its sides at the same value, so the two
 *  baked halves add up to the 2D engine's whole displacement. */
export function expandVisemeTable(
  visemes: Record<string, Partial<BlendWeights>>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [viseme, weights] of Object.entries(visemes)) {
    const arkit: Record<string, number> = {};
    for (const [key, targets] of Object.entries(SYMMETRIC_TO_ARKIT) as [keyof BlendWeights, string[]][]) {
      const value = weights[key] ?? 0;
      if (value <= 0) continue;
      for (const name of targets) arkit[name] = value;
    }
    out[viseme] = arkit;
  }
  return out;
}
