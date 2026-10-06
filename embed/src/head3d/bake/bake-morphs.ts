/**
 * Bake the 2D engine's deformers into morph-target deltas.
 *
 * The 3D head must move exactly as the 2D line does, and the lip-sync
 * controller must need no new mapping. So instead of writing a second set of
 * deformers, this drives the real AvatarEngine — the classic field, the
 * character field, the lower-face rig, the blink — on the subject's own rig,
 * one weight at a time, and records where every one of the 478 landmarks
 * went. The engine is used as it is: constructed on a stand-in canvas, its
 * face posed through its seam (engine/seam.ts), as the golden render tests
 * pose it.
 *
 * Two families come out:
 *
 *  - The 15 VISEME SHAPES, each the engine's deformation at that viseme's
 *    table weights (jaw, lips and lower face together). Exact by
 *    construction, and the 3D engine already drives `viseme_*` targets
 *    straight from its cue track (the Ready Player Me convention), blending
 *    neighbouring shapes as it co-articulates. This is the family the head
 *    speaks with.
 *  - The six SYMMETRIC WEIGHTS one at a time (jawOpen, mouthClose, ...),
 *    plus the blink, for the engine's ARKit fallback path and for anything
 *    that drives expressions by weight. Each is baked at the LARGEST value
 *    the rig's table ever asks of it and divided back to a per-unit delta:
 *    the deformers are not linear in their weights (the jaw's lens narrows
 *    as the lips round, a lip parts past a stretch threshold), so a linear
 *    target can be exact at only one point. `fidelity` reports what their
 *    linear reconstruction gets wrong at every viseme, in mouth widths —
 *    the rounded vowels are where it is worst, which is why the viseme
 *    shapes exist.
 *
 * Deltas are in IMAGE pixels (the rig's own space) per unit weight; the
 * backend turns them into head-frame metres and adds z.
 */
import { AvatarEngine } from "../../engine";
import { engineSeam, type EngineSeam } from "../../engine/seam";
import { blinkEase } from "../../engine/blink";
import { kindProfile } from "../../engine/kind-profile";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";
import { fakeCanvas, installNodeEnvironment } from "./node-env";

export const SYMMETRIC_WEIGHTS: readonly (keyof BlendWeights)[] = [
  "jawOpen",
  "mouthClose",
  "mouthPucker",
  "mouthFunnel",
  "mouthStretch",
  "mouthSmile",
];

export interface BakedTarget {
  /** The weight the engine was driven at (the table's maximum, or 1). */
  at: number;
  /** Image-pixel deltas per unit weight, one per landmark. */
  dx: number[];
  dy: number[];
}

export interface Fidelity {
  /** Largest and mean landmark error of the linear reconstruction against
   *  the engine at this viseme's table weights, in mouth widths. */
  max: number;
  mean: number;
}

export interface BakeResult {
  version: 1;
  image_size: [number, number];
  profile: string | null;
  /** Canvas px per image px during the bake (deltas are already divided by it). */
  scale: number;
  targets: Record<string, BakedTarget>;
  /** The viseme shapes, by the rig table's viseme names, whole (at = 1). */
  visemes: Record<string, BakedTarget>;
  fidelity: Record<string, Fidelity>;
}

interface Pt {
  x: number;
  y: number;
}

const LANDMARKS = 478;
const BAKE_CANVAS = 2048;

function engineFor(rig: Rig): { engine: AvatarEngine; e: EngineSeam; base: readonly Pt[]; scale: number } {
  installNodeEnvironment();
  const canvas = fakeCanvas(BAKE_CANVAS);
  const [w, h] = rig.image_size;
  const image = { naturalWidth: w, naturalHeight: h, width: w, height: h } as HTMLImageElement;
  const engine = new AvatarEngine(canvas, rig, image, { fullPhoto: true });
  const e = engineSeam(engine);
  e.face.gaze = { x: 0, y: 0 };
  e.face.blink = 0;
  const base = engine.landmarks();
  const scale = (base[454].x - base[234].x) / (rig.points[454][0] - rig.points[234][0]);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("the rig's ear landmarks coincide");
  return { engine, e, base, scale };
}

function deltas(e: EngineSeam, base: readonly Pt[], scale: number, at: number): { dx: number[]; dy: number[] } {
  const pts = e.deformedPoints();
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 0; i < LANDMARKS; i++) {
    dx.push((pts[i].x - base[i].x) / scale / at);
    dy.push((pts[i].y - base[i].y) / scale / at);
  }
  return { dx, dy };
}

/** The phase at which the 2D blink is most closed. */
export function closedBlinkPhase(): number {
  let best = 0;
  let bestValue = -1;
  for (let k = 0; k <= 200; k++) {
    const value = blinkEase(k / 200);
    if (value > bestValue) {
      bestValue = value;
      best = k / 200;
    }
  }
  return best;
}

/** The largest value of each weight in the rig's viseme table (1 when the
 *  table never uses it, so an unused target still has a shape). */
export function tableMaxima(rig: Rig): Record<keyof BlendWeights, number> {
  const out = { ...ZERO_WEIGHTS };
  for (const key of SYMMETRIC_WEIGHTS) {
    let max = 0;
    for (const weights of Object.values(rig.visemes ?? {})) max = Math.max(max, weights[key] ?? 0);
    out[key] = max > 0.05 ? max : 1;
  }
  return out;
}

export function bakeMorphTargets(rig: Rig): BakeResult {
  const { engine, e, base, scale } = engineFor(rig);
  const maxima = tableMaxima(rig);
  const targets: Record<string, BakedTarget> = {};
  try {
    for (const key of SYMMETRIC_WEIGHTS) {
      const at = maxima[key];
      e.face.weights = { ...ZERO_WEIGHTS, [key]: at };
      e.face.blink = 0;
      targets[key] = { at, ...deltas(e, base, scale, at) };
    }
    // The blink: the mesh blink at the 2D engine's own default amplitude.
    // A profile that paints its lid (toon, animal) never moves the mesh, so
    // its blink is baked from the same rig under the classic profile.
    const profile = kindProfile(rig);
    e.face.weights = { ...ZERO_WEIGHTS };
    if (profile.blink === "mesh") {
      e.face.blink = closedBlinkPhase();
      targets.eyeBlink = { at: 1, ...deltas(e, base, scale, 1) };
    } else {
      const classic = engineFor({ ...rig, render_profile: null });
      try {
        classic.e.face.weights = { ...ZERO_WEIGHTS };
        classic.e.face.blink = closedBlinkPhase();
        targets.eyeBlink = { at: 1, ...deltas(classic.e, classic.base, classic.scale, 1) };
      } finally {
        classic.engine.destroy();
      }
    }
    e.face.blink = 0;

    // The viseme shapes themselves, and how far a linear blend of the
    // symmetric targets is from each of them.
    const visemes: Record<string, BakedTarget> = {};
    const fidelity: Record<string, Fidelity> = {};
    const mouthWidth = Math.hypot(rig.points[291][0] - rig.points[61][0], rig.points[291][1] - rig.points[61][1]) || 1;
    for (const [viseme, weights] of Object.entries(rig.visemes ?? {})) {
      e.face.weights = { ...ZERO_WEIGHTS, ...weights };
      visemes[viseme] = { at: 1, ...deltas(e, base, scale, 1) };
      const actual = e.deformedPoints();
      let max = 0;
      let sum = 0;
      for (let i = 0; i < LANDMARKS; i++) {
        let x = base[i].x;
        let y = base[i].y;
        for (const key of SYMMETRIC_WEIGHTS) {
          const w = weights[key] ?? 0;
          x += targets[key].dx[i] * w * scale;
          y += targets[key].dy[i] * w * scale;
        }
        const err = Math.hypot(actual[i].x - x, actual[i].y - y) / scale / mouthWidth;
        max = Math.max(max, err);
        sum += err;
      }
      fidelity[viseme] = { max, mean: sum / LANDMARKS };
    }
    return {
      version: 1,
      image_size: [rig.image_size[0], rig.image_size[1]],
      profile: rig.render_profile ?? null,
      scale,
      targets,
      visemes,
      fidelity,
    };
  } finally {
    engine.destroy();
  }
}
