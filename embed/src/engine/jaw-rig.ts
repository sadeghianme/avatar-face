import type { BlendWeights } from "../types";

/**
 * The lower face as one rig: the jaw, the chin and the cheeks, for every
 * mouth driver.
 *
 * Three things move a face's mouth here — the classic field (photographs of
 * people fitted before the photographic mouth), the photographic mouth (the
 * person's own AI-made poses, or the Reference's retargeted) and the
 * character field (toons, animals) — and none of them moved the chin as a
 * jaw does. The classic field faded out one mouth width from the lips; the
 * photographic mouth cut its data off with a radial falloff that reached the
 * chin tip at 0.16, so a lower lip that dropped 0.28 widths on "aa" landed on
 * a chin that had moved 0.03 and the skin between them squashed to half its
 * height. The character field hinged, but stopped short of the jaw line.
 *
 * This module is built once per face from its rest mesh (the 478 MediaPipe
 * landmarks) and gives every vertex:
 *
 *  - `weight`: how much of a data-driven displacement (an AI pose) to apply.
 *    1 on the lips and the whole chin and jaw down to the jaw line, tapering
 *    along the jaw line toward the ear-side corners, fading upward through
 *    the lower cheeks to nothing at the cheekbones; exactly 0 for the eyes,
 *    brows, nose and forehead, which no mouth pose may move (the poses are
 *    registered on the eyes and nose, so what they carry there is drift).
 *  - `jaw`: the share of the chin's drop a vertex takes when the jaw is
 *    HINGED, 0..1. The mandible rotates about its joints at the ears, so
 *    the chin tip moves most and the jaw line less with each step toward
 *    the ear; the skin over the jaw's body follows it; the lower cheeks
 *    follow a little; the lips and everything above the cheekbones, nothing.
 *  - `cheek`: where the cheek bulges and hollows with the lip shapes.
 *
 * `applyLowerFace` runs after the driver each frame: it reads what the
 * driver did to the lower lip and the chin, trusts a plausible chin (the
 * character field's, a photographed one) and hinges an implausible one (the
 * classic field's, which never moved it; a pose whose chin lags its lip),
 * then lets the cheeks respond. Pure functions; the engine supplies points.
 */

export interface Pt {
  x: number;
  y: number;
}

/** The mouth's own frame in a mesh: origin at the lip seam, unit axes along
 *  the mouth (`ax, ay`, image left to right) and down the face (`nx, ny`),
 *  `w` the width corner to corner. */
export interface MouthFrame {
  cx: number;
  cy: number;
  w: number;
  ax: number;
  ay: number;
  nx: number;
  ny: number;
}

export function mouthFrame(points: readonly Pt[]): MouthFrame {
  const l = points[61],
    r = points[291];
  const w = Math.max(Math.hypot(r.x - l.x, r.y - l.y), 1);
  let ax = (r.x - l.x) / w,
    ay = (r.y - l.y) / w;
  if (ax < 0) {
    ax = -ax;
    ay = -ay;
  }
  return {
    cx: (points[13].x + points[14].x) / 2,
    cy: (points[13].y + points[14].y) / 2,
    w,
    ax,
    ay,
    nx: -ay,
    ny: ax,
  };
}

/**
 * How far the chin tip drops for a given drop of the lower lip, when the
 * jaw is hinged by this module rather than photographed.
 *
 * Measured on the Reference's own photographed poses (embed/assets/
 * mouth-motion.json, scratchpad measure.py): chin tip over outer lower lip
 * 0.63 on "aa", 0.64 on "oh", 0.45 on "ee" and "oo". The lower lip slides
 * over the teeth as the mouth opens and everts a little, so it travels
 * further than the bone beneath it; 0.68 sits at the open-vowel end of that
 * range, where the chin is most visible. Between the lip and the chin the
 * skin takes a smooth gradient from the lip's drop to the chin's, which is
 * what the photographs show (0.28, 0.24, 0.20, 0.18 widths on "aa").
 */
export const CHIN_SHARE = 0.68;

/** A chin that drops less than this share of the lower lip's drop is not a
 *  jaw opening: the driver's chin is replaced by the hinge, smoothly from
 *  the lower bound to the upper. (Reference poses: 0.45 to 0.64; the classic
 *  field: 0.) Above JAW_RATIO_MAX the chin outruns the lip, which no jaw
 *  does; the hinge takes over again. */
export const JAW_RATIO_MIN = [0.35, 0.45] as const;
export const JAW_RATIO_MAX = [1.0, 1.15] as const;

/** The jaw narrows the face as it opens: the skin of the jaw line and the
 *  lower cheeks moves inward by this fraction of what the hinge adds to
 *  their drop. Only what the hinge adds, so a photographed jaw, which
 *  carries its own narrowing, is not narrowed twice. */
export const JAW_INWARD = 0.15;

/** Cheek response to the lip shapes, in mouth widths at full weight. Real
 *  cheeks move 0.02 to 0.06 widths; these are deliberately subtle and never
 *  larger than what the jaw does. */
export const CHEEK = {
  /** Stretch/smile: the cheek lateral to the corner bulges out and up. */
  stretchOut: 0.035,
  stretchUp: 0.02,
  smileOut: 0.05,
  smileUp: 0.04,
  /** The nasolabial fold lifts and moves out with a spread lip. */
  foldStretchUp: 0.025,
  foldSmileUp: 0.04,
  foldStretchOut: 0.015,
  foldSmileOut: 0.02,
  /** Pucker/funnel: the cheeks hollow toward the mouth. */
  puckerIn: 0.03,
  funnelIn: 0.015,
} as const;

// --- The landmarks ------------------------------------------------------------

/** MediaPipe's face oval, from the forehead clockwise (image left is the
 *  face's right). */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
/** The jaw's arc of the oval, chin tip to the ear-level pivot, each side.
 *  Image left (the face's right) and image right. */
export const JAW_ARC_LEFT = [152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234];
export const JAW_ARC_RIGHT = [152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];

// MediaPipe's lip rows, corner to corner, image left to right. The upper and
// lower rows run from the inner lip outward; the commissure landmarks are the
// corners. The same indices the backend's anchor fit places.
export const INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
export const INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
export const UPPER_ROWS = [
  [191, 80, 81, 82, 13, 312, 311, 310, 415],
  [183, 42, 41, 38, 12, 268, 271, 272, 407],
  [184, 74, 73, 72, 11, 302, 303, 304, 408],
  [185, 40, 39, 37, 0, 267, 269, 270, 409],
];
export const LOWER_ROWS = [
  [95, 88, 178, 87, 14, 317, 402, 318, 324],
  [96, 89, 179, 86, 15, 316, 403, 319, 325],
  [77, 90, 180, 85, 16, 315, 404, 320, 307],
  [146, 91, 181, 84, 17, 314, 405, 321, 375],
];
export const LIP_CORNERS = [61, 76, 62, 78, 291, 306, 292, 308];

/** The nasolabial fold, each side: lifts and moves out with a spread lip. */
const NASOLABIAL = [203, 206, 216, 92, 165, 423, 426, 436, 322, 391];

/** Never moved by the mouth: the eyes with their lids and irises, the brows,
 *  the nose, the forehead and the temples. What is not listed here is still
 *  held still above the cheekbones by the geometry (see `vCheek`); this set
 *  makes the exclusion exact whatever the face's proportions. */
export const UPPER_FACE: ReadonlySet<number> = new Set([
  // eyes: lid rings, sockets, irises
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 263, 249, 390, 373, 374, 380, 381, 382,
  362, 398, 384, 385, 386, 387, 388, 466, 130, 25, 110, 24, 23, 22, 26, 112, 243, 244, 189, 56, 28, 27, 29, 30, 247,
  226, 113, 225, 224, 223, 222, 221, 190, 31, 228, 229, 230, 231, 232, 233, 128, 245, 188, 174, 359, 255, 339, 254, 253,
  252, 256, 341, 463, 464, 413, 286, 258, 257, 259, 260, 467, 446, 342, 445, 444, 443, 442, 441, 414, 261, 448, 449,
  450, 451, 452, 453, 357, 465, 412, 399, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
  // brows
  70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 300, 293, 334, 296, 336, 285, 295, 282, 283, 276,
  // nose: bridge, dorsum, tip, columella, alae and their bases
  1, 2, 4, 5, 6, 19, 20, 94, 97, 98, 99, 102, 115, 125, 129, 131, 134, 141, 166, 168, 193, 195, 196, 197, 198, 209, 217,
  218, 219, 220, 235, 236, 237, 238, 239, 240, 241, 242, 248, 250, 274, 275, 278, 281, 290, 294, 305, 309, 326, 327,
  328, 331, 344, 354, 358, 360, 363, 370, 392, 420, 429, 437, 438, 439, 440, 455, 456, 457, 458, 459, 460, 461, 462, 3,
  45, 48, 49, 51, 59, 60, 64, 75, 79, 44, 114, 122, 126, 142, 188, 196, 351, 355, 371, 419, 279, 289, 417, 343,
  // forehead and temples
  10, 338, 297, 332, 284, 251, 389, 356, 109, 67, 103, 54, 21, 162, 127, 9, 8, 151, 108, 337, 69, 299, 104, 333, 68,
  298, 71, 301, 139, 368, 34, 264, 156, 383, 35, 265, 124, 353, 143, 372, 111, 340, 117, 346, 118, 347, 119, 348, 120,
  349, 121, 350, 234, 454, 93, 323, 116, 345, 227, 447,
]);

// --- The rig ------------------------------------------------------------------

/** Vertex roles: skin, upper lip, lower lip, corner, upper face (never moved). */
export enum Role {
  Skin = 0,
  UpperLip = 1,
  LowerLip = 2,
  Corner = 3,
  UpperFace = 4,
}

export interface LowerFaceRig {
  readonly frame: MouthFrame;
  readonly n: number;
  readonly role: Uint8Array;
  /** Along the mouth, in mouth widths, signed (image left negative). */
  readonly u: Float32Array;
  /** Down the face from the lip seam, in mouth widths, signed (down positive). */
  readonly v: Float32Array;
  /** Data weight, 0..1: how much of a photographed displacement to apply. */
  readonly weight: Float32Array;
  /** Hinge share, 0..1: the fraction of the chin's drop a vertex takes. */
  readonly jaw: Float32Array;
  /** Cheek gate, 0..1: where the lip shapes bulge and hollow the cheek. */
  readonly cheek: Float32Array;
  /** The chin tip's depth below the seam, widths. */
  readonly vChin: number;
  /** The ear-level pivots' height above the seam, widths (negative). */
  readonly vCheek: number;
  /** The lower lip's thickness below the seam, widths: the ramp over which
   *  skin under the lip picks up the jaw's motion. */
  readonly ramp: number;
}

const smooth = (x: number): number => {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One side of the jaw line: for each oval vertex from the chin up to the
 *  pivot, its depth, its distance from the mouth's axis, and the fraction of
 *  the arc walked from the chin (0) to the pivot (1). */
interface JawArc {
  v: Float64Array;
  r: Float64Array;
  f: Float64Array;
}

function jawArc(indices: number[], u: Float32Array, v: Float32Array): JawArc {
  const n = indices.length;
  const av = new Float64Array(n),
    ar = new Float64Array(n),
    af = new Float64Array(n);
  let length = 0;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    av[k] = v[i];
    ar[k] = Math.abs(u[i]);
    if (k > 0) length += Math.hypot(u[i] - u[indices[k - 1]], v[i] - v[indices[k - 1]]);
    af[k] = length;
  }
  for (let k = 0; k < n; k++) af[k] = length > 0 ? af[k] / length : 0;
  return { v: av, r: ar, f: af };
}

/** The arc at depth `depth`: [arc fraction from the chin, distance from the
 *  axis]. Below the chin tip: the chin itself; above the pivot: the pivot. */
function alongArc(arc: JawArc, depth: number): [number, number] {
  const n = arc.v.length;
  if (depth >= arc.v[0]) return [0, Math.max(arc.r[0], 0.3)];
  for (let k = 1; k < n; k++) {
    // The arc climbs from the chin to the ear; a vertex that does not (a
    // fitted mesh with a kink) is simply skipped by the bracket test.
    if (depth >= arc.v[k] && arc.v[k] < arc.v[k - 1]) {
      const t = (arc.v[k - 1] - depth) / (arc.v[k - 1] - arc.v[k]);
      return [lerp(arc.f[k - 1], arc.f[k], t), lerp(arc.r[k - 1], arc.r[k], t)];
    }
  }
  return [1, arc.r[n - 1]];
}

/**
 * Build the rig from a rest mesh (478 MediaPipe landmarks; later vertices
 * are derived and get nothing).
 */
export function buildLowerFaceRig(rest: readonly Pt[], count = 478): LowerFaceRig {
  const n = Math.min(count, rest.length);
  const frame = mouthFrame(rest);
  const role = new Uint8Array(n);
  const u = new Float32Array(n),
    v = new Float32Array(n);
  const weight = new Float32Array(n),
    jaw = new Float32Array(n),
    cheek = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = rest[i].x - frame.cx,
      dy = rest[i].y - frame.cy;
    u[i] = (dx * frame.ax + dy * frame.ay) / frame.w;
    v[i] = (dx * frame.nx + dy * frame.ny) / frame.w;
  }
  for (const row of UPPER_ROWS) for (const i of row) if (i < n) role[i] = Role.UpperLip;
  for (const row of LOWER_ROWS) for (const i of row) if (i < n) role[i] = Role.LowerLip;
  for (const i of LIP_CORNERS) if (i < n) role[i] = Role.Corner;
  for (const i of UPPER_FACE) if (i < n) role[i] = Role.UpperFace;

  const vChin = Math.max(0.3, v[152] ?? 0.8);
  const vCheek = Math.min(-0.3, ((v[234] ?? -1) + (v[454] ?? -1)) / 2);
  // The outer lower lip's depth, centre: skin past it moves with the jaw.
  let lipDepth = 0;
  for (const i of LOWER_ROWS[3].slice(2, 7)) lipDepth += v[i];
  const ramp = Math.max(0.05, (lipDepth / 5) * 0.9);
  const left = jawArc(JAW_ARC_LEFT, u, v),
    right = jawArc(JAW_ARC_RIGHT, u, v);

  for (let i = 0; i < n; i++) {
    const r = role[i];
    if (r === Role.UpperFace) continue;
    const ui = u[i],
      vi = v[i],
      au = Math.abs(ui);
    // The upper lip's gate: data reaches the lip and the philtrum, never the
    // nose base above it (the photographic mouth's "below the nose" gate).
    const gate = smooth((vi + 0.4) / 0.22);
    if (r === Role.UpperLip || r === Role.LowerLip || r === Role.Corner) {
      weight[i] = r === Role.UpperLip ? gate : 1;
      continue; // the lips are the driver's; the hinge and the cheeks leave them alone
    }
    if (vi < vCheek) continue; // above the pivots: the upper face, whatever its index

    const [f, rOval] = alongArc(ui < 0 ? left : right, vi);
    // Lateral blend from the centre of the face to the jaw line: full at the
    // centre column (just inside the mouth corners), the line's own share at
    // the oval and beyond it.
    const t = smooth((au - 0.45) / Math.max(0.15, rOval - 0.45));
    // Data weight. Along the jaw line: whole down to mid-jaw (136/365, arc
    // 0.45), half at the jaw corners (58/288, 0.64), nothing at the pivots.
    const edgeW = 1 - smooth((f - 0.45) / 0.45);
    const up = vi > 0 ? 1 : 1 - smooth(-vi / -vCheek);
    const centreW = vi > 0 ? 1 : gate;
    weight[i] = lerp(centreW, edgeW * up, t);
    // Hinge share. The jaw line's share falls with the arc toward the pivots
    // (measured on the Reference: 0.92, 0.77, 0.63, 0.54, 0.49, 0.45, 0.36 of
    // the chin's drop at arc 0.09 .. 0.64 — close to 1 - arc). The centre
    // column ramps in below the lower lip and is whole from the lip's
    // thickness down; above the seam the centre column (upper lip, nose) is
    // still, and the lower cheeks take the line's share by how far out they
    // sit — about 0.4 beside the jaw corners, 0.1 by the cheekbone.
    const edgeJ = 1 - f;
    const centreJ = vi > 0 ? smooth(vi / ramp) : 0;
    jaw[i] = lerp(centreJ, edgeJ, t);
    // Cheek gate: a band about the mouth's height, lateral to the corners,
    // fading before the jaw line's far end and the cheekbone.
    cheek[i] =
      smooth((au - 0.5) / 0.3) * (1 - smooth((au - 1.0) / 0.3)) * (1 - smooth((Math.abs(vi + 0.2) - 0.35) / 0.4));
  }
  return { frame, n, role, u, v, weight, jaw, cheek, vChin, vCheek, ramp };
}

/** How far to trust a driver's chin, 0..1, from its drop over the lower
 *  lip's: 1 inside the plausible band, 0 well outside it. */
export function chinTrust(ratio: number): number {
  return (
    smooth((ratio - JAW_RATIO_MIN[0]) / (JAW_RATIO_MIN[1] - JAW_RATIO_MIN[0])) *
    (1 - smooth((ratio - JAW_RATIO_MAX[0]) / (JAW_RATIO_MAX[1] - JAW_RATIO_MAX[0])))
  );
}

export interface LowerFaceReport {
  /** The lower lip's drop this frame, canvas px, down the face. */
  lipDrop: number;
  /** The chin tip's drop before and after the pass. */
  chinBefore: number;
  chinAfter: number;
  /** How far the driver's chin was trusted. */
  trust: number;
}

/**
 * The lower-face pass, run after the mouth driver has moved the lips.
 *
 * `pts` are the frame's vertices (canvas px), `rest` the still face. The
 * lower lip's drop is read off vertex 17 (outer lower lip, centre), the
 * chin's off 152. `gain` scales the cheeks' own shapes (the owner's jaw
 * range, which already scaled whatever the driver did).
 */
export function applyLowerFace(
  pts: Pt[],
  rest: readonly Pt[],
  rig: LowerFaceRig,
  w: BlendWeights,
  gain = 1
): LowerFaceReport {
  const f = rig.frame;
  const W = f.w;
  const drop = (i: number) => (pts[i].x - rest[i].x) * f.nx + (pts[i].y - rest[i].y) * f.ny;
  const lipDrop = drop(17);
  const chinBefore = drop(152);
  // A lip that barely moved (closed, or rising for /f/) has no jaw to hinge;
  // the driver's chin stands, whatever it is.
  const opening = lipDrop > W * 0.01;
  const trust = opening ? chinTrust(chinBefore / lipDrop) : 1;
  const hinge = opening ? CHIN_SHARE * lipDrop : 0;
  // The chin after the pass: the driver's, the hinge's, or between.
  const chinAfter = trust * chinBefore + (1 - trust) * Math.max(chinBefore, hinge);

  const stretchOut = (w.mouthStretch * CHEEK.stretchOut + w.mouthSmile * CHEEK.smileOut) * W * gain;
  const stretchUp = (w.mouthStretch * CHEEK.stretchUp + w.mouthSmile * CHEEK.smileUp) * W * gain;
  const hollow = (w.mouthPucker * CHEEK.puckerIn + w.mouthFunnel * CHEEK.funnelIn) * W * gain;

  for (let i = 0; i < rig.n; i++) {
    if (rig.role[i] !== Role.Skin) continue;
    const share = rig.jaw[i];
    let da = 0,
      dn = 0;
    if (share > 0) {
      const have = drop(i);
      // Below the seam: the jaw's body, hinged only as far as the driver's
      // chin is not trusted. Above it: the lower cheeks, which follow the
      // chin (whoever moved it) by their share, and never less.
      const want = rig.v[i] > 0 ? hinge * share : chinAfter * share;
      const add = rig.v[i] > 0 ? (1 - trust) * Math.max(0, want - have) : Math.max(0, want - have);
      if (add > 0) {
        dn += add;
        da -= Math.sign(rig.u[i]) * JAW_INWARD * add;
      }
    }
    const g = rig.cheek[i];
    if (g > 0) {
      da += Math.sign(rig.u[i]) * (stretchOut - hollow) * g;
      dn -= stretchUp * g;
    }
    if (da !== 0 || dn !== 0) {
      pts[i].x += da * f.ax + dn * f.nx;
      pts[i].y += da * f.ay + dn * f.ny;
    }
  }
  // The nasolabial fold lifts and moves out with a spread lip.
  const foldUp = (w.mouthStretch * CHEEK.foldStretchUp + w.mouthSmile * CHEEK.foldSmileUp) * W * gain;
  const foldOut = (w.mouthStretch * CHEEK.foldStretchOut + w.mouthSmile * CHEEK.foldSmileOut) * W * gain;
  if (foldUp > 0 || foldOut > 0) {
    for (const i of NASOLABIAL) {
      if (i >= rig.n || rig.role[i] !== Role.Skin) continue;
      const da = Math.sign(rig.u[i]) * foldOut,
        dn = -foldUp;
      pts[i].x += da * f.ax + dn * f.nx;
      pts[i].y += da * f.ay + dn * f.ny;
    }
  }
  return { lipDrop, chinBefore, chinAfter, trust };
}
