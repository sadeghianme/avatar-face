import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh, type HeadGeom, type Point } from "../geometry";
import { NeckWarp, headShare, neckBlendFor, neckPin, neckPinOffset } from "../neck-blend";
import { composeFrame, headMotionAffine } from "../render2d";
import { apply } from "../warp-gl";

/**
 * A layered avatar's neck (neck-blend.ts): the share of the head's motion
 * falls from 1 at the chin to 0 at the neck band's bottom; the layers drawn
 * through the warp and the band placed by it agree; and the layers come
 * out whole, with no line where the warp's triangles meet, even through a
 * half-transparent feather.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;

/** A band reaching 30 px either side of x 150, from a chin at y 100 to its
 *  bottom at 180, the line rising beside it half a pixel per pixel on
 *  average, eased, to 80 px higher 160 px out. */
const BLEND = { top: 100, bottom: 180, cx: 150, halfWidth: 30, slope: 0.5 };

describe("the neck's share of the head's motion", () => {
  const blend = BLEND;

  it("is the head's down to the chin, the body's below the band, eased between, under the neck", () => {
    for (const x of [120, 150, 180]) {
      expect(headShare(blend, x, 0)).toBe(1);
      expect(headShare(blend, x, 100)).toBe(1);
      expect(headShare(blend, x, 180)).toBe(0);
      expect(headShare(blend, x, 400)).toBe(0);
      let last = 1;
      for (let y = 100; y <= 180; y += 2) {
        const s = headShare(blend, x, y);
        expect(s).toBeLessThanOrEqual(last);
        last = s;
      }
      expect(headShare(blend, x, 140)).toBeCloseTo(0.5, 9);
    }
  });

  it("leaves a shoulder beside the band with the body, the line rising a neck's height at most", () => {
    // 80 px out from the band the share starts to fall 40 px higher.
    expect(headShare(blend, 260, 60)).toBe(1);
    expect(headShare(blend, 260, 100)).toBeCloseTo(0.5, 9);
    expect(headShare(blend, 40, 100)).toBeCloseTo(0.5, 9);
    // Far out, at the chin's height, the shoulders are the body's alone;
    // the line has levelled off a neck's height (80 px) above the chin.
    expect(headShare(blend, 600, 100)).toBe(0);
    expect(headShare(blend, 600, 20)).toBe(1);
    expect(headShare(blend, -400, 60)).toBeCloseTo(0.5, 9);
  });

  it("runs from a mesh's chin to its neck band's bottom", () => {
    const [W, H] = rig.image_size;
    const image = { naturalWidth: W, naturalHeight: H } as HTMLImageElement;
    const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
    refineMesh(mesh, rig, image);
    const b = neckBlendFor(mesh)!;
    expect(b.top).toBe(mesh.basePoints[152].y);
    expect(b.bottom).toBe(Math.max(...mesh.neckBand.map((v) => v.base.y)));
    expect(b.bottom).toBeGreaterThan(b.top);
    expect(b.cx).toBe(mesh.basePoints[152].x);
    // Level as far as the band reaches.
    for (const v of mesh.neckBand) expect(Math.abs(v.base.x - b.cx)).toBeLessThan(b.halfWidth);
  });
});

describe("the neck's warp", () => {
  const picture = { x: -20, y: -10, w: 340, h: 300 };
  const blend = BLEND;
  const geom = { pivotX: 160, pivotY: 260, bustPivotY: 0, bustReach: 1 };
  const head = headMotionAffine(geom, { dx: 4, dy: -2.5, roll: 0.03 }, false);

  it("is nothing for a head at rest on its body", () => {
    const warp = new NeckWarp(blend, picture);
    warp.update({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    for (const p of [
      { x: 10, y: 20 },
      { x: 150, y: 130 },
      { x: 300, y: 250 },
    ]) {
      const q = warp.at(p);
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    }
  });

  it("moves all of the head down to the chin, none of the body below the band, and tears nothing between", () => {
    const warp = new NeckWarp(blend, picture);
    warp.update(head);
    // Above where the share falls anywhere, and over the neck above the
    // chin: the head's motion, exactly.
    for (const p of [
      { x: 0, y: 0 },
      { x: 300, y: 15 },
      { x: 150, y: 95 },
      { x: 175, y: 60 },
    ]) {
      const q = warp.at(p),
        want = apply(head, p);
      expect(q.x).toBeCloseTo(want.x, 9);
      expect(q.y).toBeCloseTo(want.y, 9);
    }
    // Below the band, and the shoulders beside the neck at its height: the
    // body's.
    for (const p of [
      { x: 0, y: 181 },
      { x: 250, y: 280 },
      { x: 310, y: 150 },
      { x: -15, y: 140 },
    ]) {
      const q = warp.at(p);
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    }
    // Continuous: a step of a hundredth of a pixel moves a point by about
    // as much, across every row and column.
    for (let y = 90; y <= 190; y += 0.37) {
      for (const x of [-15, 60.2, 145, 230.7, 315]) {
        const a = warp.at({ x, y }),
          b = warp.at({ x: x + 0.01, y: y + 0.01 });
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.05);
      }
    }
    // The grid's own corners are where its triangles put them.
    for (const t of warp.triangles()) {
      t.rest.forEach((p, k) => {
        const q = warp.at(p);
        expect(q.x).toBeCloseTo(t.moved[k].x, 9);
        expect(q.y).toBeCloseTo(t.moved[k].y, 9);
      });
    }
  });

  it("places the neck band where it puts the layers: the band's bottom with the body", () => {
    const warp = new NeckWarp(blend, picture);
    const pin = neckPin(warp, head);
    // Above the chin, nothing to add: the mesh is drawn through the head's
    // motion already.
    const o0 = neckPinOffset(pin, { x: 120, y: 80 });
    expect(Math.hypot(o0.x, o0.y)).toBeLessThan(1e-9);
    // Anywhere, the band vertex drawn through the head's motion lands where
    // the warp puts the layers (body frame).
    for (const p of [
      { x: 120, y: 120 },
      { x: 60, y: 160 },
      { x: 200, y: 180 },
    ]) {
      const o = neckPinOffset(pin, p);
      const drawn = apply(head, { x: p.x + o.x, y: p.y + o.y });
      const under = warp.at(p);
      expect(drawn.x).toBeCloseTo(under.x, 9);
      expect(drawn.y).toBeCloseTo(under.y, 9);
    }
    // The band's bottom: where the body holds it.
    const bottom = { x: 150, y: 180 };
    const o = neckPinOffset(pin, bottom);
    const drawn = apply(head, { x: bottom.x + o.x, y: bottom.y + o.y });
    expect(drawn.x).toBeCloseTo(bottom.x, 9);
    expect(drawn.y).toBeCloseTo(bottom.y, 9);
  });
});

describe("the layers drawn through the neck's warp", () => {
  const W = 300,
    H = 280;
  const picture = { x: 6.3, y: -4.7, w: 290, h: 290 };
  const geom: HeadGeom = {
    x: 40,
    y: 0,
    w: 220,
    h: 200,
    pivotX: 150,
    pivotY: 260,
    yawPx: 4,
    pitchPx: 3,
    faceH: 120,
    bustPivotY: 300,
    bustReach: 200,
  };
  // A neck as wide as the picture: the share by height alone.
  const blend = { top: 110, bottom: 190, cx: 150, halfWidth: 400, slope: 0.5 };
  let body: HTMLImageElement, headLayer: HTMLImageElement;

  beforeAll(async () => {
    // The body: opaque, colour across it (vertical stripes); the head: the
    // same stripes in another colour, its alpha feathered from whole above
    // y 120 to nothing at y 200, as a head layer fades down a neck.
    const make = async (head: boolean) => {
      const c = createCanvas(200, 200);
      const g = c.getContext("2d");
      const img = g.createImageData(200, 200);
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 200; x++) {
          const i = (y * 200 + x) * 4;
          const stripe = 0.5 + 0.5 * Math.sin(x / 3);
          img.data[i] = head ? 40 + 180 * stripe : 200;
          img.data[i + 1] = head ? 90 : 60 + 150 * stripe;
          img.data[i + 2] = head ? 160 : 40;
          img.data[i + 3] = head ? Math.round(255 * Math.max(0, Math.min(1, (138 - y) / 55))) : 255;
        }
      }
      g.putImageData(img, 0, 0);
      return (await loadImage(c.toBuffer("image/png"))) as unknown as HTMLImageElement;
    };
    body = await make(false);
    headLayer = await make(true);
  });
  beforeEach(() => vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) }));
  afterEach(() => vi.unstubAllGlobals());

  const draw = (offset: { dx: number; dy: number; roll: number } | null) => {
    const c = createCanvas(W, H);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    let neck = null;
    if (offset) {
      const warp = new NeckWarp(blend, picture);
      warp.update(headMotionAffine(geom, offset, false));
      neck = { warp, scratch: createCanvas(1, 1) as unknown as HTMLCanvasElement };
    }
    composeFrame({
      ctx,
      picture,
      texture: body,
      layers: { body, head: headLayer },
      cutOut: false,
      head: geom,
      headLayer: null,
      headOffset: { dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0, ...(offset ?? {}) },
      bodyLean: null,
      neck,
      drawMesh: () => undefined,
      drawFeatures: () => undefined,
    });
    return ctx.getImageData(0, 0, W, H).data as unknown as Uint8ClampedArray;
  };
  /** A pixel as the canvas holds it: premultiplied (an all but clear
   *  pixel's colour is noise once divided by its alpha). */
  const at = (d: Uint8ClampedArray, x: number, y: number) => {
    const i = (y * W + x) * 4;
    const a = d[i + 3] / 255;
    return [d[i] * a, d[i + 1] * a, d[i + 2] * a, d[i + 3]];
  };

  it("are the layers as they were while the head does not move", () => {
    const plain = draw(null);
    const warped = draw({ dx: 0, dy: 0, roll: 0 });
    let worst = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = at(plain, x, y),
          b = at(warped, x, y);
        for (let k = 0; k < 4; k++) {
          worst = Math.max(worst, Math.abs(a[k] - b[k]));
        }
      }
    expect(worst).toBeLessThanOrEqual(6);
  });

  it("move the head layer with the head above the chin, keep both still below the neck, and draw no line between", () => {
    const still = draw(null);
    const moved = draw({ dx: 3, dy: 0, roll: 0 });
    // Below the band: the still picture, pixel for pixel near enough.
    let below = 0;
    for (let y = 200; y < H; y++)
      for (let x = 2; x < W - 6; x++) below = Math.max(below, Math.abs(at(still, x, y)[1] - at(moved, x, y)[1]));
    expect(below).toBeLessThanOrEqual(2);
    // Above the chin: the still picture shifted 3 px.
    let above = 0;
    for (let y = 10; y < 100; y++)
      for (let x = 10; x < W - 10; x++)
        above = Math.max(
          above,
          Math.max(...[0, 1, 2].map((k) => Math.abs(at(still, x - 3, y)[k] - at(moved, x, y)[k])))
        );
    expect(above).toBeLessThanOrEqual(3);
    // Through the neck, no horizontal line: each row against the mean of
    // the rows two above and below it, over the whole width, is no further
    // off than the stripes' own slant makes it (the warp's rows are at
    // 110, 123.3, ... 190: a seam or a doubled feather would sit on one).
    const rowLine = (y: number) => {
      let sum = 0;
      for (let x = 20; x < W - 20; x++)
        for (let k = 0; k < 3; k++)
          sum += Math.abs(at(moved, x, y)[k] - (at(moved, x, y - 2)[k] + at(moved, x, y + 2)[k]) / 2);
      return sum / ((W - 40) * 3);
    };
    const lines = Array.from({ length: 100 }, (_, k) => rowLine(100 + k));
    const median = [...lines].sort((a, b) => a - b)[50];
    expect(Math.max(...lines)).toBeLessThan(median * 2 + 1.5);
  });
});

void ({} as Point);
