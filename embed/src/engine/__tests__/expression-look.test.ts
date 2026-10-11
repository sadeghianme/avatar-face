import { createCanvas } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { ExpressionRig, NONE } from "../expression-rig";
import { APERTURE_DRAWN, readLook, SKIN_GRAIN } from "../expression-look";
import { ANIMAL_GAINS, HUMAN_GAINS, TOON_GAINS } from "../expression-table";
import { faceFrame, toFace } from "../expression-weights";
import type { Point } from "../geometry";
import { expressionGains, HUMAN_PROFILE } from "../kind-profile";

/**
 * Creases only for real photographs (docs/emotions.md, "Skin cues"): a
 * person's photo takes the shaded skin cues; a cartoon, an animal, and a
 * stylised or airbrushed face laid out as a person (large drawn eyes, flat
 * skin) take none, and an animal takes the animal's faint amplitudes
 * whatever its rig says.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const photo: Point[] = rig.points.map(([x, y]) => ({ x, y }));
const frame = faceFrame(photo)!;

/** The face with its eyes opened to `aperture` IODs (the lower lids
 *  lowered), as a stylised character's large drawn eyes are. */
function drawnEyes(aperture: number): Point[] {
  const pts = photo.map((p) => ({ ...p }));
  for (const [upper, lower] of [
    [159, 145],
    [386, 374],
  ]) {
    const now = Math.hypot(pts[upper].x - pts[lower].x, pts[upper].y - pts[lower].y) / frame.iod;
    pts[lower].y += (aperture - now) * frame.iod;
  }
  return pts;
}

/** A skin's luminance at a face-frame point: flat (an airbrushed render)
 *  or with a camera's grain of `grain` percent. */
function skin(grain: number): (p: Point) => number {
  return (p) => {
    // A fixed hash of the texel: a reproducible noise.
    const k = Math.round(p.x * 997) * 7919 + Math.round(p.y * 991) * 104729;
    const n = (((k * 2654435761) >>> 0) % 1000) / 1000 - 0.5;
    return 170 * (1 + (n * grain * 3.46) / 100);
  };
}
const local = (pts: readonly Point[]) => pts.map((p) => toFace(frame, p));
const TEXEL = 1 / 400; // IODs: a 400 px IOD picture

describe("the look of a person's picture", () => {
  it("reads a photograph's eyes and grain as a photograph", () => {
    const look = readLook(local(photo), skin(3), TEXEL);
    expect(look.aperture).toBeLessThan(APERTURE_DRAWN);
    expect(look.grain!).toBeGreaterThan(SKIN_GRAIN);
    expect(look.photographic).toBe(true);
    // A smoothed or small photo keeps its cues: its eyes are a person's.
    expect(readLook(local(photo), skin(0.2), TEXEL).photographic).toBe(true);
    // Unreadable (a cross-origin picture): the eyes decide.
    expect(readLook(local(photo), null, TEXEL).photographic).toBe(true);
  });

  it("reads a stylised face's large eyes on flat skin as no photograph", () => {
    const drawn = local(drawnEyes(0.27));
    expect(readLook(drawn, skin(0.3), TEXEL).aperture).toBeGreaterThan(APERTURE_DRAWN);
    expect(readLook(drawn, skin(0.3), TEXEL).photographic).toBe(false);
    expect(readLook(drawn, null, TEXEL).photographic).toBe(false);
    // A wide-eyed person whose skin has a photograph's grain keeps them.
    expect(readLook(drawn, skin(3), TEXEL).photographic).toBe(true);
  });

  it("gives the cues to a photograph's rig only, and paints nothing on the others", () => {
    const luma = (grain: number) =>
      Object.assign((p: Point) => skin(grain)(toFace(frame, p)), { texel: TEXEL * frame.iod });
    const real = ExpressionRig.build(photo, rig.triangles, HUMAN_GAINS, luma(3))!;
    const styled = ExpressionRig.build(drawnEyes(0.27), rig.triangles, HUMAN_GAINS, luma(0.3))!;
    expect(real.cueGain).toBe(1);
    expect(styled.cueGain).toBe(0);
    const paint = (r: ExpressionRig) => {
      const W = 1200,
        H = 1400;
      const c = createCanvas(W, H);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "rgb(200,160,140)";
      ctx.fillRect(0, 0, W, H);
      r.paintCues(ctx as unknown as CanvasRenderingContext2D, photo, { ...NONE, happy: 1, surprised: 1 }, 1);
      const d = ctx.getImageData(0, 0, W, H).data;
      let changed = 0;
      for (let k = 0; k < W * H; k++) if (d[4 * k] !== 200 || d[4 * k + 1] !== 160 || d[4 * k + 2] !== 140) changed++;
      return changed;
    };
    expect(paint(real)).toBeGreaterThan(1000);
    expect(paint(styled)).toBe(0);
  });
});

describe("the expression gains by face type", () => {
  it("takes the rig's own for a person, no cues for a cartoon, the animal's for an animal", () => {
    expect(expressionGains(HUMAN_PROFILE, "human")).toBe(HUMAN_GAINS);
    expect(expressionGains(HUMAN_PROFILE, null)).toBe(HUMAN_GAINS);
    expect(expressionGains(HUMAN_PROFILE, "cartoon")).toEqual({ ...HUMAN_GAINS, cues: 0 });
    expect(expressionGains({ expression: TOON_GAINS }, "cartoon").cues).toBe(0);
    // A cat fitted with the human profile still moves as an animal: faint,
    // and unshaded.
    expect(expressionGains(HUMAN_PROFILE, "animal")).toBe(ANIMAL_GAINS);
    expect(ANIMAL_GAINS.cues).toBe(0);
    expect(TOON_GAINS.cues).toBe(0);
  });
});
