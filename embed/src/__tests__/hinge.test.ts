import { describe, expect, it } from "vitest";

import { hingeShare } from "../engine";

/**
 * The jaw hinge: which vertices drop when the mouth opens, and by how
 * much. Pinned because every constant here was arrived at by looking at a
 * photograph — the plateau version tore the lip into spikes, the y-ramp
 * version dragged the upper lip down with the lower — and a later "tidy"
 * would not know which shapes it was undoing.
 */
const LOWER_CENTRE = 17; // lower lip, outer, centre
const LOWER_INNER = 14;
const UPPER_CENTRE = 0;
const UPPER_INNER = 13;
const CORNER = 61;

describe("hingeShare", () => {
  it("drops the whole lower lip and none of the upper lip at the centre", () => {
    expect(hingeShare(LOWER_CENTRE, 0, 1.2, 1.05)).toBeCloseTo(1, 5);
    expect(hingeShare(LOWER_INNER, 0, 0.08, 1.05)).toBeCloseTo(1, 5);
    expect(hingeShare(UPPER_CENTRE, 0, -0.56, 1.05)).toBe(0);
    // The inner rings sit at the same height when closed: identity, not y,
    // must separate them.
    expect(hingeShare(UPPER_INNER, 0, 0.05, 1.05)).toBe(0);
  });

  it("is a lens: fades toward the corners and is zero just past them", () => {
    const centre = hingeShare(LOWER_CENTRE, 0, 1, 1.05);
    const mid = hingeShare(LOWER_CENTRE, 0.6, 1, 1.05);
    const nearCorner = hingeShare(LOWER_CENTRE, 0.95, 1, 1.05);
    expect(centre).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(nearCorner);
    expect(nearCorner).toBeGreaterThan(0);
    expect(hingeShare(LOWER_CENTRE, 1.1, 1, 1.05)).toBe(0);
  });

  it("corners take half, so the lip meets the corner without a step", () => {
    const lipBesideCorner = hingeShare(LOWER_CENTRE, 0.85, 0.5, 1.05);
    const corner = hingeShare(CORNER, 0.85, 0, 1.05);
    expect(corner).toBeCloseTo(lipBesideCorner / 2, 5);
  });

  it("skin below the seam follows the lip; skin above it stays", () => {
    const skinBelow = hingeShare(400, 0, 1.5, 1.05); // not a lip landmark
    const skinAbove = hingeShare(400, 0, -0.5, 1.05);
    expect(skinBelow).toBeCloseTo(1, 5);
    expect(skinAbove).toBe(0);
  });

  it("agrees between lip and skin at the same x — no shear across the lip edge", () => {
    for (const nx of [0, 0.3, 0.6, 0.9]) {
      expect(hingeShare(LOWER_CENTRE, nx, 1.2, 1.05)).toBeCloseTo(hingeShare(400, nx, 1.2, 1.05), 5);
    }
  });

  it("a rounded shape opens a narrower lens", () => {
    const wide = hingeShare(LOWER_CENTRE, 0.7, 1, 1.05);
    const round = hingeShare(LOWER_CENTRE, 0.7, 1, 0.65);
    expect(round).toBeLessThan(wide);
    expect(hingeShare(LOWER_CENTRE, 0.7, 1, 0.65)).toBe(0); // past the narrow lens
  });
});
