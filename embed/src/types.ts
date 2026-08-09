/** Shared types for the rig format (v3) and speech cues. */

export interface BlendWeights {
  jawOpen: number;
  mouthClose: number;
  mouthPucker: number;
  mouthFunnel: number;
  mouthStretch: number;
  mouthSmile: number;
}

export interface Rig {
  version: number;
  image_size: [number, number];
  face_box: [number, number, number, number];
  points: [number, number][];
  triangles: [number, number, number][];
  mouth_indices: number[];
  inner_lip_ring: number[];
  outer_lip_ring: number[];
  visemes: Record<string, Partial<BlendWeights>>;
  blendshapes?: Record<string, number> | null;
}

export interface Cue {
  t: number;
  viseme: string;
  /** How fully to reach the shape, 0..1. Unstressed syllables reduce — a
   * schwa is a small mouth. Absent (older API) means "fully". */
  a?: number;
}

export interface SynthesisPayload {
  audio_b64: string;
  audio_mime: string;
  duration_ms: number;
  cues: Cue[];
  cached: boolean;
}

/** Live-adjustable animation parameters (all multipliers/thresholds). */
export interface EngineTuning {
  /** Scales all mouth displacement (jaw, lips). 1 = default. */
  mouthOpen: number;
  /** Scales viseme approach rates. <1 smoother/lazier, >1 snappier. */
  smoothness: number;
  /** Mouth openness above which teeth appear (0..1). */
  teethThreshold: number;
  /** Teeth band height as a fraction of mouth width. */
  teethHeight: number;
  /** Scales idle/speech head motion. 0 disables. */
  headMotion: number;
  /** Scales body sway and breathing. 0 disables them. */
  bodyMotion: number;
  /** Blink amplitude, 0..1. Set 0 to stop blinking entirely.
   *
   * A photo of open eyes holds no record of the closed eye, so a blink can
   * only be approximated, and every approximation shows on some face. This is
   * the escape hatch: on a portrait where it still reads wrong, turn it off
   * and lose nothing but the blink. */
  blink: number;
}

export const DEFAULT_TUNING: EngineTuning = {
  mouthOpen: 1,
  smoothness: 1,
  teethThreshold: 0.45,
  teethHeight: 0.07,
  headMotion: 1,
  bodyMotion: 1,
  // Small on purpose. The lid moves the mesh, which compresses the eyeball
  // texture as it comes down; measured on real portraits, the compression
  // becomes visible as a wash across the eye well before the lid looks
  // closed. This is the largest sweep that stays under that.
  blink: 0.22,
};

export const ZERO_WEIGHTS: BlendWeights = {
  jawOpen: 0,
  mouthClose: 0,
  mouthPucker: 0,
  mouthFunnel: 0,
  mouthStretch: 0,
  mouthSmile: 0,
};

/**
 * Derive v3 blendshape weights from legacy v1/v2 rigs that only stored
 * open/width/round per viseme.
 */
export function weightsFromLegacy(v: {
  open?: number;
  width?: number;
  round?: number;
}): BlendWeights {
  const open = v.open ?? 0;
  const width = v.width ?? 0.5;
  const round = v.round ?? 0;
  return {
    jawOpen: open,
    mouthClose: open < 0.05 ? 0.5 : 0,
    mouthPucker: round,
    mouthFunnel: round * 0.7,
    mouthStretch: Math.max(0, width - 0.5) * 2 * (1 - round),
    mouthSmile: Math.max(0, width - 0.6) * 1.5 * (1 - round),
  };
}
