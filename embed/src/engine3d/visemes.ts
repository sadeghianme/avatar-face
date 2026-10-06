/**
 * What the 3D engine's mouth is asked to do, as plain functions of the cue
 * track: which morph target each viseme is, how far each is pushed at a
 * moment of the track, and how a viseme becomes ARKit blendshape values for
 * a model that has no viseme targets.
 */
import type { Cue } from "../types";

/** Viseme -> ARKit blendshape weights. */
export type ArkitWeights = Record<string, number>;

/** Oculus viseme -> Ready Player Me morph-target name. ih/oh/ou are I/O/U
 *  in RPM's naming. */
export const VISEME_TO_MORPH: Readonly<Record<string, string>> = {
  sil: "viseme_sil", PP: "viseme_PP", FF: "viseme_FF", TH: "viseme_TH",
  DD: "viseme_DD", kk: "viseme_kk", CH: "viseme_CH", SS: "viseme_SS",
  nn: "viseme_nn", RR: "viseme_RR", aa: "viseme_aa", E: "viseme_E",
  ih: "viseme_I", oh: "viseme_O", ou: "viseme_U",
};

/** Every viseme morph target, in table order. */
export const MORPH_NAMES: readonly string[] = Object.values(VISEME_TO_MORPH);

/** How far the cue track pushes the viseme it is on (and the one it is
 *  heading for, cross-faded). */
export const CUE_PEAK = 0.85;

/**
 * The fallback for models WITHOUT viseme morphs but WITH raw ARKit
 * blendshapes (Avaturn, Avatar SDK, Blender ARKit rigs, three.js facecap...):
 * each viseme decomposed into ARKit weights, the table the 2D rig uses.
 */
export const DEFAULT_VISEME_ARKIT: Readonly<Record<string, ArkitWeights>> = {
  sil: { mouthClose: 0.1 },
  PP: { jawOpen: 0.05, mouthClose: 0.9, mouthPucker: 0.25 },
  FF: { jawOpen: 0.1, mouthClose: 0.55, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  TH: { jawOpen: 0.25, mouthClose: 0.2, mouthFunnel: 0.15 },
  DD: { jawOpen: 0.3, mouthClose: 0.15, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
  kk: { jawOpen: 0.35, mouthClose: 0.1, mouthFunnel: 0.1 },
  CH: { jawOpen: 0.25, mouthPucker: 0.35, mouthFunnel: 0.4 },
  SS: { jawOpen: 0.15, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.25, mouthSmileRight: 0.25 },
  nn: { jawOpen: 0.2, mouthClose: 0.25, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  RR: { jawOpen: 0.25, mouthPucker: 0.3, mouthFunnel: 0.3 },
  aa: { jawOpen: 0.85, mouthFunnel: 0.1, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
  E: { jawOpen: 0.45, mouthStretchLeft: 0.5, mouthStretchRight: 0.5, mouthSmileLeft: 0.35, mouthSmileRight: 0.35 },
  ih: { jawOpen: 0.3, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.3, mouthSmileRight: 0.3 },
  oh: { jawOpen: 0.6, mouthPucker: 0.5, mouthFunnel: 0.55 },
  ou: { jawOpen: 0.35, mouthPucker: 0.85, mouthFunnel: 0.6 },
};

/** Every ARKit name a decomposition table drives, once each. */
export function arkitNamesOf(table: Readonly<Record<string, ArkitWeights>>): string[] {
  return [...new Set(Object.values(table).flatMap((w) => Object.keys(w)))];
}

/** A morph's index in a mesh's dictionary, tolerating both ARKit suffix
 *  conventions (mouthSmileLeft vs mouthSmile_L). */
export function morphIndex(dictionary: Readonly<Record<string, number>>, name: string): number | undefined {
  if (name in dictionary) return dictionary[name];
  const aliased = name.replace(/Left$/, "_L").replace(/Right$/, "_R");
  return dictionary[aliased];
}

/** Every viseme morph at 0. */
export function restingMorphs(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of MORPH_NAMES) out[name] = 0;
  return out;
}

/**
 * The viseme morphs the cue track asks for at cue time `t`: the cue in
 * effect at CUE_PEAK, cross-fading linearly into the next as `t` crosses
 * the span between them; silence asks for nothing. Before the first cue
 * everything rests; on the last cue (or one with no span) it holds.
 */
export function cueMorphTargets(cues: readonly Cue[], t: number): Record<string, number> {
  const targets = restingMorphs();
  let index = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].t <= t) index = i;
    else break;
  }
  if (index < 0) return targets;
  const curr = VISEME_TO_MORPH[cues[index].viseme];
  const next = cues[index + 1];
  if (!next || next.t <= cues[index].t) {
    if (curr && curr !== "viseme_sil") targets[curr] = CUE_PEAK;
    return targets;
  }
  const f = Math.min(1, Math.max(0, (t - cues[index].t) / (next.t - cues[index].t)));
  const nextMorph = VISEME_TO_MORPH[next.viseme];
  if (curr && curr !== "viseme_sil") targets[curr] = CUE_PEAK * (1 - f);
  if (nextMorph && nextMorph !== "viseme_sil") targets[nextMorph] = (targets[nextMorph] ?? 0) + CUE_PEAK * f;
  return targets;
}

/**
 * Move each viseme morph's weight toward its target, in place: a fixed
 * share per frame, faster opening than closing, scaled by the owner's
 * smoothness and capped. Returns the largest non-silence weight (how open
 * the mouth is, for the speech energy).
 */
export function dampMorphs(
  weights: Record<string, number>,
  targets: Readonly<Record<string, number>>,
  mouthOpen: number,
  smoothness: number
): number {
  let jaw = 0;
  for (const name of MORPH_NAMES) {
    const target = Math.min(1, (targets[name] ?? 0) * mouthOpen);
    const rate = Math.min(0.6, (target > weights[name] ? 0.35 : 0.2) * smoothness);
    weights[name] += (target - weights[name]) * rate;
    if (name !== "viseme_sil") jaw = Math.max(jaw, weights[name]);
  }
  return jaw;
}

/**
 * The ARKit values for viseme morph weights, through a decomposition
 * table: each viseme's ARKit weights scaled by how far it is pushed, summed
 * and capped at 1. A viseme below 0.01 contributes nothing; every name in
 * `names` is present (0 when nothing drives it).
 */
export function decomposeVisemes(
  weights: Readonly<Record<string, number>>,
  table: Readonly<Record<string, ArkitWeights>>,
  names: readonly string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) out[name] = 0;
  for (const [viseme, morphName] of Object.entries(VISEME_TO_MORPH)) {
    const weight = weights[morphName];
    if (weight < 0.01) continue;
    for (const [arkitName, value] of Object.entries(table[viseme] ?? {})) {
      out[arkitName] = Math.min(1, (out[arkitName] ?? 0) + value * weight);
    }
  }
  return out;
}
