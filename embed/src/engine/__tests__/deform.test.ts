import { describe, expect, it, vi } from "vitest";

import { blinkEase } from "../blink";
import type { CharacterField } from "../character-mouth";
import { HUMAN_PROFILE, kindProfile } from "../kind-profile";
import type { MouthExtension } from "../../mouth-extension";
import { DEFAULT_TUNING, ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";
import { deformFace, type DeformInput } from "../deform";
import type { FaceMesh, Point } from "../geometry";
import { LANDMARK_COUNT, LEFT_BROW, LOWER_LIDS, RIGHT_BROW, UPPER_LIDS } from "../landmarks";
import { restingFace } from "../state";

/**
 * The deformation (deform.ts) on a tiny synthetic face: a mouth 200 px wide
 * centred at (500, 700), two eyes and two brows at the landmarks the engine
 * reads, a chin, and every other landmark parked in a row far from all of
 * them. Two midpoint vertices and one neck-band vertex stand for the
 * engine's derived ones.
 */

const UPPER_OUTER = [185, 40, 39, 37, 0, 267, 269, 270, 409];
const UPPER_INNER = [191, 80, 81, 82, 13, 312, 311, 310, 415];
const LOWER_INNER = [95, 88, 178, 87, 14, 317, 402, 318, 324];
const LOWER_OUTER = [146, 91, 181, 84, 17, 314, 405, 321, 375];
const CORNERS: [number, number][] = [[61, 400], [76, 402], [78, 405], [62, 408], [292, 592], [308, 595], [306, 598], [291, 600]];
const INNER_RING = [78, ...LOWER_INNER, 308, ...[...UPPER_INNER].reverse()];
const CHIN = 152;

function syntheticRig(): Rig {
  const points: [number, number][] = Array.from({ length: LANDMARK_COUNT }, (_, i) => [2000 + i * 3, 0]);
  const row = (indices: number[], y: number) => indices.forEach((i, k) => (points[i] = [420 + k * 20, y]));
  row(UPPER_OUTER, 680);
  row(UPPER_INNER, 698);
  row(LOWER_INNER, 702);
  row(LOWER_OUTER, 720);
  for (const [i, x] of CORNERS) points[i] = [x, 700];
  points[CHIN] = [500, 820];
  // Eyes: corners, then lids 25 px above and 12 below the corner line.
  const eye = (c0: number, c1: number, x0: number, upper: number[], lower: number[]) => {
    points[c0] = [x0, 400];
    points[c1] = [x0 + 100, 400];
    upper.forEach((i, k) => (points[i] = [x0 + 12.5 * (k + 1), 375]));
    lower.forEach((i, k) => (points[i] = [x0 + 12.5 * (k + 1), 412]));
  };
  eye(33, 133, 350, UPPER_LIDS[0], LOWER_LIDS[0]);
  eye(362, 263, 550, UPPER_LIDS[1], LOWER_LIDS[1]);
  LEFT_BROW.forEach((i, k) => (points[i] = [440 - k * 20, 340]));
  RIGHT_BROW.forEach((i, k) => (points[i] = [560 + k * 20, 340]));
  const mouth = [...UPPER_OUTER, ...UPPER_INNER, ...LOWER_INNER, ...LOWER_OUTER, ...CORNERS.map(([i]) => i)];
  return {
    image_size: [3500, 1000],
    points,
    triangles: [],
    mouth_indices: mouth,
    inner_lip_ring: INNER_RING,
    visemes: {},
  } as unknown as Rig;
}

const rig = syntheticRig();

function mesh(): FaceMesh {
  const basePoints = rig.points.map(([x, y]) => ({ x, y }));
  return {
    scale: 1, offsetX: 0, offsetY: 0,
    picture: { x: 0, y: 0, w: 3500, h: 1000 },
    basePoints,
    texPoints: basePoints.map((p) => ({ ...p })),
    derivedParents: [[13, 14], [61, 13]],
    neckBand: [{ base: { x: 500, y: 900 }, parent: CHIN, share: 0.5 }],
    triangles: [],
  };
}

function deform(weights: Partial<BlendWeights> = {}, extra: Partial<DeformInput> & { blink?: number; gaze?: Point } = {}): Point[] {
  const face = restingFace();
  face.weights = { ...ZERO_WEIGHTS, ...weights };
  face.blink = extra.blink ?? 0;
  face.gaze = extra.gaze ?? { x: 0, y: 0 };
  return deformFace({
    rig, mesh: mesh(), innerRing: INNER_RING, face,
    tuning: { ...DEFAULT_TUNING }, profile: HUMAN_PROFILE, field: null,
    traits: HUMAN_PROFILE.traits, lowerFace: null, mouthExtension: undefined,
    ...extra,
  });
}

const base = mesh().basePoints;
const dy = (pts: Point[], i: number) => pts[i].y - base[i].y;
const BROWS = new Set([...LEFT_BROW, ...RIGHT_BROW]);

describe("deformFace", () => {
  it("at rest moves only the brows' inner ends, a little, up", () => {
    const pts = deform();
    expect(pts).toHaveLength(LANDMARK_COUNT + 2 + 1);
    base.forEach((p, i) => {
      if (!BROWS.has(i)) expect(pts[i]).toEqual(p);
    });
    // Half the face's height x 0.035 x the resting browInnerUp (0.06).
    const fh = (Math.max(...base.map((p) => p.y)) - Math.min(...base.map((p) => p.y))) / 2;
    for (const brow of [LEFT_BROW, RIGHT_BROW]) {
      expect(dy(pts, brow[0])).toBeCloseTo(-fh * 0.035 * 0.06, 9);
      expect(dy(pts, brow[brow.length - 1])).toBe(0);
    }
  });

  it("drops the lower lip as a hinge, full at the centre and tapering to the corners; the upper lip stays", () => {
    const pts = deform({ jawOpen: 1 });
    const mouthH = 720 - 680;
    // The lower lip's centre drops the whole JAW_DROP (0.74) of the mouth's
    // height, less the falloff of its 2 px from the centre.
    expect(dy(pts, 14)).toBeGreaterThan(0.74 * mouthH * 0.99);
    expect(dy(pts, 14)).toBeLessThanOrEqual(0.74 * mouthH);
    expect(Math.abs(dy(pts, 13))).toBeLessThan(1);
    // A lens across the lower lip: the centre most, the corners half or less.
    const across = [17, 84, 181, 91, 146].map((i) => dy(pts, i));
    for (let k = 1; k < across.length; k++) expect(across[k]).toBeLessThan(across[k - 1]);
    expect(dy(pts, 61)).toBeLessThan(dy(pts, 17) / 2);
    // Skin below the seam goes with it, faded by distance: the chin drops,
    // less than the lip. Nothing above the mouth moves.
    expect(dy(pts, CHIN)).toBeGreaterThan(1);
    expect(dy(pts, CHIN)).toBeLessThan(dy(pts, 17));
    for (const i of [...UPPER_LIDS[0], ...LOWER_LIDS[1], 33, 263]) expect(pts[i]).toEqual(base[i]);
  });

  it("opens a narrower lens on a rounded shape", () => {
    const open = deform({ jawOpen: 0.6 });
    const rounded = deform({ jawOpen: 0.6, mouthPucker: 1 });
    expect(dy(rounded, 14)).toBeCloseTo(dy(open, 14), 9);
    expect(dy(rounded, 91)).toBeLessThan(dy(open, 91) * 0.8);
    // And draws the corners in.
    expect(rounded[61].x).toBeGreaterThan(open[61].x);
    expect(rounded[291].x).toBeLessThan(open[291].x);
  });

  it("presses the inner lips together toward the mouth's centre line on mouthClose", () => {
    const pts = deform({ mouthClose: 1 });
    // 0.8 of the way to the centre line (y 700), the falloff a hair under 1.
    expect(pts[14].y).toBeCloseTo(702 - 2 * 0.8, 1);
    expect(pts[13].y).toBeCloseTo(698 + 2 * 0.8, 1);
    expect(pts[17]).toEqual(base[17]);
  });

  it("widens and lifts the corners on a smile, and the smile reaches the eyes", () => {
    const pts = deform({ mouthSmile: 0.5 });
    expect(pts[291].x).toBeGreaterThan(base[291].x);
    expect(pts[291].y).toBeLessThan(base[291].y);
    expect(pts[61].x).toBeLessThan(base[61].x);
    // The lower lid rises 0.12 x smile of its way to the top of the upper lid.
    for (const i of LOWER_LIDS[0]) expect(dy(pts, i)).toBeCloseTo(-(412 - 375) * 0.5 * 0.12, 9);
  });

  it("moves nothing of the mouth when the tuning's mouthOpen is 0", () => {
    const pts = deform({ jawOpen: 1, mouthStretch: 1, mouthPucker: 0.5 }, { tuning: { ...DEFAULT_TUNING, mouthOpen: 0 } });
    for (const i of rig.mouth_indices) expect(pts[i]).toEqual(base[i]);
    expect(pts[CHIN]).toEqual(base[CHIN]);
  });

  it("sweeps the upper lid down on a mesh blink, its middle furthest, and lifts the lower lid a little", () => {
    const pts = deform({}, { blink: 0.3 });
    const amount = blinkEase(0.3);
    // Above and below the eye's centre: the lid's full share of the sweep
    // from its top (375) to its bottom (412).
    const [upper, lower] = [UPPER_LIDS[0][3], LOWER_LIDS[0][3]];
    expect(dy(pts, upper)).toBeCloseTo((412 - 375) * amount * DEFAULT_TUNING.blink, 9);
    expect(dy(pts, UPPER_LIDS[0][0])).toBeLessThan(dy(pts, upper));
    expect(dy(pts, UPPER_LIDS[0][0])).toBeGreaterThan(0);
    // The lower lid rises 0.12 of the way, whatever the tuning's strength.
    expect(dy(pts, lower)).toBeCloseTo(-(412 - 375) * amount * 0.12, 9);
  });

  it("lowers the lids a little with a downward gaze, and not with an upward one", () => {
    const down = deform({}, { gaze: { x: 0, y: 0.4 } });
    const up = deform({}, { gaze: { x: 0, y: -0.4 } });
    expect(dy(down, UPPER_LIDS[1][3])).toBeGreaterThan(0);
    expect(dy(up, UPPER_LIDS[1][3])).toBe(0);
  });

  it("leaves the lids to the painter for a profile that blinks with a painted lid", () => {
    const lid = kindProfile({ render_profile: "toon@1" });
    expect(lid.blink).toBe("lid");
    const pts = deform({}, { blink: 0.3, profile: lid });
    for (const i of [...UPPER_LIDS[0], ...LOWER_LIDS[0]]) expect(pts[i]).toEqual(base[i]);
  });

  it("hands the mouth to a character field instead of the classic one", () => {
    const apply = vi.fn<CharacterField["apply"]>((pts) => {
      pts[14] = { x: pts[14].x, y: pts[14].y + 7 };
    });
    const field = { apply } as unknown as CharacterField;
    const pts = deform({ jawOpen: 1 }, { field });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][2]).toBe(DEFAULT_TUNING.mouthOpen);
    expect(dy(pts, 14)).toBe(7);
    expect(pts[17]).toEqual(base[17]);
  });

  it("lets a mouth extension move the points after the classic field, before the derived vertices", () => {
    const extension: MouthExtension = {
      deform: (points) => {
        points[13].y -= 10;
      },
      draw: () => undefined,
    };
    const plain = deform({ jawOpen: 0.5 });
    const pts = deform({ jawOpen: 0.5 }, { mouthExtension: extension });
    expect(pts[13].y).toBeCloseTo(plain[13].y - 10, 9);
    expect(pts[LANDMARK_COUNT].y).toBeCloseTo((pts[13].y + pts[14].y) / 2, 9);
  });

  it("carries the derived vertices with their parents: midpoints between, the neck band by its share", () => {
    const pts = deform({ jawOpen: 0.8, mouthStretch: 0.4 });
    expect(pts[LANDMARK_COUNT]).toEqual({ x: (pts[13].x + pts[14].x) / 2, y: (pts[13].y + pts[14].y) / 2 });
    expect(pts[LANDMARK_COUNT + 1]).toEqual({ x: (pts[61].x + pts[13].x) / 2, y: (pts[61].y + pts[13].y) / 2 });
    const neck = pts[LANDMARK_COUNT + 2];
    expect(neck.x).toBeCloseTo(500 + (pts[CHIN].x - base[CHIN].x) * 0.5, 9);
    expect(neck.y).toBeCloseTo(900 + dy(pts, CHIN) * 0.5, 9);
  });
});
