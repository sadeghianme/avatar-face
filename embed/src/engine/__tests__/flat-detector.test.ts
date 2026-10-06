import { describe, expect, it } from "vitest";

import { sampleLook, type Pt, type Rgb } from "../character-mouth";
import { decodePng } from "../../__tests__/png-fixture";

/**
 * Is the picture cel art? Checked on crops (120 x 96, at the picture's own
 * pixels, round the mouth) of the five REAL AI-made characters the wizard
 * produced, because the first version of the test passed on synthetic
 * pictures and failed on real flat art: AI-made cartoons carry light noise
 * and soft gradients, and a test that wanted near-identical neighbours called
 * them renders, which lost the drawn outline, the flat teeth and the pink
 * tongue.
 */

function lookOf(file: string) {
  const { w, h, rgb } = decodePng(file);
  const pixel = (x: number, y: number): Rgb | null => {
    const px = Math.round(x),
      py = Math.round(y);
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    const i = (py * w + px) * 3;
    return [rgb[i], rgb[i + 1], rgb[i + 2]];
  };
  // The sampler looks at 3 mouth-widths by 2.4: the crop is that area.
  const width = w / 3;
  const cx = w / 2,
    cy = h * 0.375;
  const seam: Pt[] = [
    { x: cx - width * 0.3, y: cy },
    { x: cx, y: cy },
    { x: cx + width * 0.3, y: cy },
  ];
  return sampleLook(pixel, seam, { cx, cy, w: width }, [150, 90, 80], [200, 160, 140]);
}

describe("telling cel art from a render or a photograph, on real pictures", () => {
  it.each(["human-cartoon", "animal-cartoon"])("calls the %s drawing flat", (name) => {
    expect(lookOf(`${name}-mouth.png`).flat).toBe(true);
  });

  it.each(["human-animation", "animal-animation", "animal-realistic"])("does not call the %s picture flat", (name) => {
    expect(lookOf(`${name}-mouth.png`).flat).toBe(false);
  });
});
