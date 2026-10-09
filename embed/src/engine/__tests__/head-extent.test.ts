import { readFileSync } from "node:fs";
import { loadImage } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SKULL_CENTRE_CM, fitCanonical } from "../head-depth";
import { skullOutline } from "../head-extent";
import { FIXTURES, OVAL, meshFor, portraits, rig, stubCanvasDocument } from "./head-fixtures";

/**
 * Where the head ends, read off the pictures (head-extent.ts): at the
 * hair's edge over a plain backdrop, a little past a cut-out's silhouette,
 * never past the picture, and nowhere on a picture that cannot be read;
 * and the skull's own outline, where the background cannot be told.
 */
let photo: HTMLImageElement;
let cutOut: HTMLImageElement;
beforeAll(async () => {
  ({ photo, cutOut } = await portraits());
});
beforeEach(stubCanvasDocument);
afterEach(() => vi.unstubAllGlobals());

describe("where the head ends", () => {
  it("ends at the hair's edge over a plain backdrop, never past the picture", () => {
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    const pic = mesh.picture;
    for (const s of head.spokes.slice(1, -1)) {
      expect(s.outer).toBeGreaterThan(s.r0);
      const end = { x: head.centre.x + s.dir.x * s.outer, y: head.centre.y + s.dir.y * s.outer };
      expect(end.x).toBeGreaterThan(pic.x);
      expect(end.x).toBeLessThan(pic.x + pic.w);
      expect(end.y).toBeGreaterThan(pic.y);
    }
    // Beside the temples the backdrop shows: the field there ends within a
    // tenth of an eye distance of the hair's edge.
    const side = head.spokes.find((s) => s.landmark === 162)!;
    expect(side.silhouette).toBeLessThan(side.outer + 0.06 * head.iod);
    expect(side.outer - side.silhouette).toBeLessThan(0.1 * head.iod);
  });

  it("on a cut-out, ends a little past the silhouette, in the clear", () => {
    const mesh = meshFor(cutOut, true);
    const head = mesh.head!;
    const k = mesh.scale * (rig.image_size[0] / cutOut.naturalWidth);
    for (const s of head.spokes.slice(1, -1)) {
      // The oval's edge along the spoke, canvas px from the centre.
      const ox = mesh.offsetX + OVAL.cx * k,
        oy = mesh.offsetY + OVAL.cy * k;
      let r = s.r0;
      while (
        Math.hypot(
          (head.centre.x + s.dir.x * r - ox) / (OVAL.rx * k),
          (head.centre.y + s.dir.y * r - oy) / (OVAL.ry * k)
        ) < 1
      )
        r += 0.5;
      if (r >= s.r0 + 1.5 * head.iod) continue;
      expect(Math.abs(s.silhouette - r)).toBeLessThan(0.04 * head.iod);
      expect(s.outer).toBeGreaterThan(s.silhouette);
      expect(s.outer - s.silhouette).toBeLessThanOrEqual(0.12 * head.iod + 1e-6);
    }
  });

  it("is not laid on a picture that cannot be read", async () => {
    const tainted = (await loadImage(
      readFileSync(new URL("pixels/reference-portrait.webp", FIXTURES))
    )) as unknown as HTMLImageElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => {
            throw new Error("SecurityError: tainted");
          },
        }),
      }),
    });
    const mesh = meshFor(tainted, false);
    expect(mesh.head).toBeUndefined();
  });
});

describe("the skull's outline", () => {
  it("is an ellipse about the skull's centre, taller than broad, the canonical skull's size", () => {
    const mesh = meshFor(photo, false);
    const fit = fitCanonical(mesh.basePoints);
    const skull = skullOutline(fit);
    const up = skull({ x: 0, y: -1 }),
      down = skull({ x: 0, y: 1 }),
      left = skull({ x: -1, y: 0 }),
      right = skull({ x: 1, y: 0 });
    // Symmetric through the centre, as an ellipse is.
    expect(up).toBeCloseTo(down, 9);
    expect(left).toBeCloseTo(right, 9);
    expect(up).toBeGreaterThan(left);
    // Half of a 15.5 cm breadth and of a 21 cm height, a little inflated
    // for the hair, over the canonical 8.89 cm eye distance: 0.92 and 1.24
    // eye distances, about, for a face that looks into the camera.
    expect(left / fit.iod).toBeGreaterThan(0.85);
    expect(left / fit.iod).toBeLessThan(1.05);
    expect(up / fit.iod).toBeGreaterThan(1.15);
    expect(up / fit.iod).toBeLessThan(1.4);
    // The centre itself lies on the face's middle line, above the eyes.
    const c = fit.at(SKULL_CENTRE_CM);
    expect(Math.abs(c.x - (mesh.basePoints[234].x + mesh.basePoints[454].x) / 2)).toBeLessThan(0.1 * fit.iod);
    expect(c.y).toBeLessThan(mesh.basePoints[1].y);
  });
});
