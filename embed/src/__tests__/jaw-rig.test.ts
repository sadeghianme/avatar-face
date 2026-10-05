import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyLowerFace, buildLowerFaceRig, buildNeckBand, CHEEK, CHIN_SHARE, chinTrust, JAW_ARC, LOWER_ROWS, mouthFrame,
  NECK_BAND, Role, UPPER_FACE, type Pt,
} from "../jaw-rig";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../types";

/**
 * The lower-face rig: the weight map an AI pose is applied through, the jaw
 * hinge that moves the chin for a driver that did not, and the cheeks.
 * Pinned on two real faces: the detected human fixture rig and the
 * Reference's own rest pose (the face the bundled motion is measured on).
 */

const fixture = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const motion = JSON.parse(readFileSync(new URL("../../assets/mouth-motion.json", import.meta.url), "utf8")) as {
  poses: { points: [number, number][] }[];
};
const human: Pt[] = fixture.points.map(([x, y]) => ({ x, y }));
const reference: Pt[] = motion.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));

const EYES = [33, 133, 159, 145, 263, 362, 386, 374, 468, 473];
const BROWS = [55, 65, 52, 285, 295, 282, 70, 300];
const NOSE = [1, 2, 4, 5, 6, 19, 94, 168, 195, 197, 48, 278, 98, 327, 129, 358, 64, 294];
const FOREHEAD = [10, 338, 109, 9, 8, 151, 21, 251, 103, 332];
const LIPS_LOWER = LOWER_ROWS.flat();

const weights = (w: Partial<BlendWeights>): BlendWeights => ({ ...ZERO_WEIGHTS, ...w });
const copy = (pts: readonly Pt[]) => pts.map((p) => ({ x: p.x, y: p.y }));
const dist = (p: readonly Pt[], i: number, j: number) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);

/** A driver that drops the whole lower lip by `lip` px and the chin by
 *  `chin` px, straight down the face, and nothing else: the classic field's
 *  shape (chin 0), or a photographed pose's. */
function drive(rest: readonly Pt[], lip: number, chin = 0): Pt[] {
  const f = mouthFrame(rest);
  const pts = copy(rest);
  for (const i of LIPS_LOWER) { pts[i].x += lip * f.nx; pts[i].y += lip * f.ny; }
  if (chin) { pts[152].x += chin * f.nx; pts[152].y += chin * f.ny; }
  return pts;
}

describe.each([["human fixture", human], ["Reference rest", reference]])("lower-face weight map on the %s", (_name, rest) => {
  const rig = buildLowerFaceRig(rest);
  const W = rig.frame.w;

  it("is exactly 0 for the eyes, brows, nose and forehead", () => {
    for (const i of [...EYES, ...BROWS, ...NOSE, ...FOREHEAD]) {
      expect(rig.weight[i], `weight ${i}`).toBe(0);
      expect(rig.jaw[i], `jaw ${i}`).toBe(0);
      expect(rig.cheek[i], `cheek ${i}`).toBe(0);
      expect(UPPER_FACE.has(i)).toBe(true);
    }
  });

  it("excludes the upper face symmetrically: every still landmark has a still mirror", () => {
    // A landmark listed on one side of the face and not the other would let
    // a pose move one nostril (it did: 49 without 279). The face is close to
    // symmetric, so each excluded vertex must have an excluded twin across
    // the mouth's axis.
    for (const i of UPPER_FACE) {
      if (i >= rig.n) continue;
      let twin = false;
      for (const j of UPPER_FACE) {
        if (j >= rig.n) continue;
        if (Math.abs(rig.u[j] + rig.u[i]) < 0.08 && Math.abs(rig.v[j] - rig.v[i]) < 0.08) { twin = true; break; }
      }
      expect(twin, `landmark ${i} has no excluded mirror`).toBe(true);
    }
  });

  it("is whole on the lips and all the way down the chin", () => {
    for (const i of [13, 14, 17, 0, 18, 200, 199, 175, 152]) expect(rig.weight[i], `weight ${i}`).toBeCloseTo(1, 5);
  });

  it("has no step across the lip seam, nor between the lip and the skin below it", () => {
    expect(rig.weight[13]).toBe(rig.weight[14]);
    expect(Math.abs(rig.weight[17] - rig.weight[18])).toBeLessThan(0.01);
    // Beside the corners, the skin just above and just below the seam agree.
    for (const [above, below] of [[212, 57], [432, 287]]) {
      expect(Math.abs(rig.weight[above] - rig.weight[below])).toBeLessThan(0.25);
    }
  });

  it("follows the jaw line in full to mid-jaw and tapers toward the ear-side corners", () => {
    for (const i of [148, 377, 176, 400, 149, 378, 150, 379]) expect(rig.weight[i], `weight ${i}`).toBeGreaterThan(0.85);
    for (const i of [136, 365]) expect(rig.weight[i], `weight ${i}`).toBeGreaterThan(0.75);
    for (const i of [58, 288]) {
      expect(rig.weight[i], `weight ${i}`).toBeGreaterThan(0.3);
      expect(rig.weight[i], `weight ${i}`).toBeLessThan(0.85);
    }
    expect(rig.weight[58]).toBeLessThan(rig.weight[136]);
    expect(rig.weight[132]).toBeLessThan(rig.weight[58]);
    for (const i of [234, 454, 93, 323]) expect(rig.weight[i]).toBe(0);
  });

  it("fades upward through the lower cheeks to nothing at the cheekbones", () => {
    // Jaw-side cheek, mid cheek, cheekbone: decreasing, the last near zero.
    expect(rig.weight[214]).toBeGreaterThan(rig.weight[50]);
    expect(rig.weight[434]).toBeGreaterThan(rig.weight[280]);
    expect(rig.weight[50]).toBeLessThan(0.3);
    expect(rig.weight[123]).toBeLessThan(0.15);
    expect(rig.weight[352]).toBeLessThan(0.15);
  });

  it("keeps the upper lip's gate: the philtrum partly, the nose base not at all", () => {
    expect(rig.weight[164]).toBeGreaterThan(0);
    expect(rig.weight[164]).toBeLessThan(1);
    expect(rig.weight[2]).toBe(0);
  });

  it("gives the hinge its shares: whole at the chin, tapering along the jaw line, a little in the cheeks", () => {
    expect(rig.jaw[152]).toBeCloseTo(1, 5);
    expect(rig.jaw[200]).toBeCloseTo(1, 5);
    expect(rig.jaw[148]).toBeGreaterThan(rig.jaw[136]);
    expect(rig.jaw[136]).toBeGreaterThan(rig.jaw[58]);
    expect(rig.jaw[58]).toBeGreaterThan(0.2);
    expect(rig.jaw[58]).toBeLessThan(0.6);
    for (const i of [50, 280]) {
      expect(rig.jaw[i]).toBeGreaterThan(0.02);
      expect(rig.jaw[i]).toBeLessThan(0.3);
    }
    for (const i of LIPS_LOWER) expect(rig.jaw[i]).toBe(0);
    expect(rig.vChin * W).toBeGreaterThan(W * 0.5);
  });
});

describe("the jaw hinge (classic driver: the lip drops, the chin did not)", () => {
  for (const [name, rest] of [["human fixture", human], ["Reference rest", reference]] as const) {
    const rig = buildLowerFaceRig(rest);
    const W = rig.frame.w;

    it(`${name}: the chin tip drops CHIN_SHARE of the lower lip's drop, at every opening`, () => {
      for (const open of [0.1, 0.25, 0.5, 0.75, 1]) {
        const lip = open * 0.3 * W;
        const pts = drive(rest, lip);
        const r = applyLowerFace(pts, rest, rig, weights({ jawOpen: open }));
        expect(r.trust).toBe(0);
        expect((pts[152].y - rest[152].y) / lip).toBeCloseTo(CHIN_SHARE, 2);
      }
      expect(CHIN_SHARE).toBeGreaterThan(0.6);
      expect(CHIN_SHARE).toBeLessThan(0.75);
    });

    it(`${name}: the chin's skin moves as one piece with the jaw`, () => {
      // From the sulcus below the lip down to the chin tip the skin is rigid
      // with the mandible: its height holds within 10% over the whole range.
      // The lip itself slides over the bone and travels further, as in the
      // photographs (the Reference's "aa": lip-to-chin -17%).
      for (const open of [0.25, 0.5, 0.75, 1]) {
        const lip = open * 0.3 * W;
        const pts = drive(rest, lip);
        applyLowerFace(pts, rest, rig, weights({ jawOpen: open }));
        expect(Math.abs(dist(pts, 200, 152) / dist(rest, 200, 152) - 1)).toBeLessThan(0.1);
        expect(Math.abs(dist(pts, 18, 152) / dist(rest, 18, 152) - 1)).toBeLessThan(0.1);
        const lipToChin = dist(pts, 17, 152) / dist(rest, 17, 152) - 1;
        expect(lipToChin).toBeLessThan(0);
        expect(lipToChin).toBeGreaterThan(-0.2);
        // And monotone down the centre line: no fold between lip and chin
        // (within 1% of the lip's drop: the centre landmarks are not on one
        // exact vertical, so the lateral blend varies by a hair).
        const drops = [17, 18, 200, 199, 175, 152].map((i) => pts[i].y - rest[i].y);
        for (let k = 1; k < drops.length; k++) expect(drops[k]).toBeLessThanOrEqual(drops[k - 1] + lip * 0.01);
      }
    });

    it(`${name}: the jaw line drops with the chin and tapers to nothing at the pivots`, () => {
      const lip = 0.3 * W;
      const pts = drive(rest, lip);
      applyLowerFace(pts, rest, rig, weights({ jawOpen: 1 }));
      const drop = (i: number) => pts[i].y - rest[i].y;
      expect(drop(148)).toBeGreaterThan(drop(136));
      expect(drop(136)).toBeGreaterThan(drop(58));
      expect(drop(58)).toBeGreaterThan(0);
      expect(drop(132)).toBeLessThan(drop(58));
      expect(drop(234)).toBe(0);
      expect(drop(454)).toBe(0);
      // Both sides alike.
      expect(Math.abs(drop(136) - drop(365))).toBeLessThan(lip * 0.1);
      // The face narrows a little as the jaw opens: the jaw line moves inward.
      expect(pts[136].x - rest[136].x).toBeGreaterThan(0);
      expect(pts[365].x - rest[365].x).toBeLessThan(0);
    });

    it(`${name}: the eyes, brows, nose and forehead do not move at all`, () => {
      const pts = drive(rest, 0.3 * W);
      applyLowerFace(pts, rest, rig, weights({ jawOpen: 1, mouthStretch: 1, mouthSmile: 1, mouthPucker: 1, mouthFunnel: 1 }));
      for (const i of [...EYES, ...BROWS, ...NOSE, ...FOREHEAD]) {
        expect(pts[i].x, `x ${i}`).toBe(rest[i].x);
        expect(pts[i].y, `y ${i}`).toBe(rest[i].y);
      }
    });

    it(`${name}: a lip that closes or rises leaves the chin alone`, () => {
      const pts = drive(rest, -0.04 * W);
      const r = applyLowerFace(pts, rest, rig, weights({ mouthClose: 0.5 }));
      expect(r.trust).toBe(1);
      expect(pts[152].y).toBe(rest[152].y);
    });
  }
});

describe("trusting the driver's own chin", () => {
  const rig = buildLowerFaceRig(reference);
  const W = rig.frame.w;

  it("is whole inside the plausible band and gone outside it", () => {
    expect(chinTrust(0.1)).toBe(0);
    expect(chinTrust(0.3)).toBe(0);
    expect(chinTrust(0.45)).toBe(1);
    expect(chinTrust(0.68)).toBe(1);
    expect(chinTrust(1.0)).toBe(1);
    expect(chinTrust(1.3)).toBe(0);
    // Smooth between: no snap as a pose crosses the bound.
    let previous = chinTrust(0.3);
    for (let r = 0.3; r <= 0.5; r += 0.005) {
      const t = chinTrust(r);
      expect(t - previous).toBeGreaterThanOrEqual(0);
      expect(t - previous).toBeLessThan(0.1);
      previous = t;
    }
  });

  it("keeps a photographed chin that dropped a plausible share of the lip", () => {
    const lip = 0.28 * W;
    const pts = drive(reference, lip, 0.63 * lip);
    const r = applyLowerFace(pts, reference, rig, weights({ jawOpen: 0.72 }));
    expect(r.trust).toBe(1);
    expect((pts[152].y - reference[152].y) / lip).toBeCloseTo(0.63, 3);
  });

  it("hinges a chin that lagged its lip", () => {
    const lip = 0.28 * W;
    const pts = drive(reference, lip, 0.1 * lip);
    const r = applyLowerFace(pts, reference, rig, weights({ jawOpen: 0.72 }));
    expect(r.trust).toBe(0);
    expect((pts[152].y - reference[152].y) / lip).toBeCloseTo(CHIN_SHARE, 2);
  });
});

describe("the neck band", () => {
  const rig = buildLowerFaceRig(reference);
  const f = rig.frame;
  const FIRST = 478 + 200;
  const band = buildNeckBand(reference, FIRST);
  const n = JAW_ARC.length;

  it("is two rings below the jaw line, pivot to pivot, the inner following and the outer still", () => {
    expect(band.vertices).toHaveLength(2 * n);
    expect(band.triangles).toHaveLength(4 * (n - 1));
    for (let k = 0; k < n; k++) {
      const inner = band.vertices[k], outer = band.vertices[n + k];
      expect(inner.parent).toBe(JAW_ARC[k]);
      expect(outer.parent).toBe(JAW_ARC[k]);
      expect(inner.share).toBe(NECK_BAND.innerShare);
      expect(outer.share).toBe(0);
      // Outside the jaw line, further for the outer ring.
      const p = reference[JAW_ARC[k]];
      const out = (q: { x: number; y: number }) => Math.hypot(q.x - f.cx, q.y - f.cy) - Math.hypot(p.x - f.cx, p.y - f.cy);
      expect(out(inner)).toBeGreaterThan(f.w * 0.2);
      expect(out(outer)).toBeGreaterThan(out(inner));
    }
    // Below the chin tip by the stated offsets.
    const chin = JAW_ARC.indexOf(152);
    expect((band.vertices[chin].y - reference[152].y) / f.w).toBeCloseTo(NECK_BAND.inner, 1);
    expect((band.vertices[n + chin].y - reference[152].y) / f.w).toBeCloseTo(NECK_BAND.outer, 1);
  });

  it("triangulates the band to the jaw line with valid, non-degenerate triangles", () => {
    const all = [...reference];
    for (let i = reference.length; i < FIRST; i++) all.push({ x: 0, y: 0 });
    for (const v of band.vertices) all.push({ x: v.x, y: v.y });
    for (const [a, b, c] of band.triangles) {
      for (const i of [a, b, c]) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(all.length);
        expect(i < 478 || i >= FIRST).toBe(true);
      }
      const area = (all[b].x - all[a].x) * (all[c].y - all[a].y) - (all[c].x - all[a].x) * (all[b].y - all[a].y);
      expect(Math.abs(area)).toBeGreaterThan(f.w * f.w * 0.001);
    }
  });

  it("makes the mesh's outer edge stand still: nothing moves where the still picture begins", () => {
    for (let k = 0; k < n; k++) expect(band.vertices[n + k].share).toBe(0);
    expect(NECK_BAND.innerShare).toBeGreaterThan(0.5);
    expect(NECK_BAND.innerShare).toBeLessThan(1);
    expect(NECK_BAND.outer).toBeGreaterThan(NECK_BAND.inner);
  });
});

describe("the cheeks", () => {
  const rig = buildLowerFaceRig(reference);
  const W = rig.frame.w;
  const dx = (pts: readonly Pt[], i: number) => (pts[i].x - reference[i].x) / W;
  const dy = (pts: readonly Pt[], i: number) => (pts[i].y - reference[i].y) / W;

  it("follow an opening jaw downward, more by the jaw line than by the cheekbone, and a little inward", () => {
    const lip = 0.28 * W;
    const pts = drive(reference, lip);
    applyLowerFace(pts, reference, rig, weights({ jawOpen: 0.72 }));
    for (const [jawSide, cheekbone] of [[214, 50], [434, 280]]) {
      expect(dy(pts, jawSide)).toBeGreaterThan(dy(pts, cheekbone));
      expect(dy(pts, cheekbone)).toBeGreaterThan(0.005);
      expect(dy(pts, cheekbone)).toBeLessThan(0.06);
    }
    // Inward: image-left points move right, image-right points move left.
    expect(dx(pts, 214)).toBeGreaterThan(0);
    expect(dx(pts, 434)).toBeLessThan(0);
  });

  it("bulge out and up on a spread lip, and lift the nasolabial fold", () => {
    const pts = copy(reference);
    applyLowerFace(pts, reference, rig, weights({ mouthStretch: 0.72, mouthSmile: 0.08 }));
    for (const [left, right] of [[50, 280], [205, 425], [187, 411]]) {
      expect(dx(pts, left)).toBeLessThan(-0.005);
      expect(dx(pts, right)).toBeGreaterThan(0.005);
      expect(dy(pts, left)).toBeLessThan(0);
      expect(Math.abs(dx(pts, left))).toBeLessThan(0.06);
    }
    for (const [left, right] of [[206, 426], [92, 322]]) {
      expect(dy(pts, left)).toBeLessThan(-0.01);
      expect(dy(pts, right)).toBeLessThan(-0.01);
      expect(dx(pts, left)).toBeLessThan(0);
      expect(dx(pts, right)).toBeGreaterThan(0);
    }
  });

  it("hollow toward the mouth on a rounded lip", () => {
    const pts = copy(reference);
    applyLowerFace(pts, reference, rig, weights({ mouthPucker: 0.85, mouthFunnel: 0.55 }));
    for (const [left, right] of [[50, 280], [205, 425]]) {
      expect(dx(pts, left)).toBeGreaterThan(0.005);
      expect(dx(pts, right)).toBeLessThan(-0.005);
      expect(Math.abs(dx(pts, left))).toBeLessThan(0.06);
    }
  });

  it("are subtle: every cheek constant is within what real cheeks do", () => {
    for (const v of Object.values(CHEEK)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(0.06);
    }
  });

  it("scale with the owner's jaw range", () => {
    const full = copy(reference), half = copy(reference);
    applyLowerFace(full, reference, rig, weights({ mouthStretch: 1 }), 1);
    applyLowerFace(half, reference, rig, weights({ mouthStretch: 1 }), 0.5);
    expect(dx(half, 280)).toBeCloseTo(dx(full, 280) / 2, 6);
  });

  it("leave the lips to the driver", () => {
    const pts = copy(reference);
    applyLowerFace(pts, reference, rig, weights({ jawOpen: 1, mouthStretch: 1, mouthPucker: 1 }));
    for (const i of [...LIPS_LOWER, 0, 13, 61, 291]) {
      expect(rig.role[i]).not.toBe(Role.Skin);
      expect(pts[i]).toEqual(reference[i]);
    }
  });
});
