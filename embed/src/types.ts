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
}

export interface SynthesisPayload {
  audio_b64: string;
  audio_mime: string;
  duration_ms: number;
  cues: Cue[];
  cached: boolean;
}

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
