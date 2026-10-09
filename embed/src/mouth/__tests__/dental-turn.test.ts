import { readFileSync } from "node:fs";
import { Path2D, createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { centralMouthAnchors, type MouthPoint, type MouthSurfaceFrame, type MouthTurn } from "../../mouth-extension";
import { ZERO_WEIGHTS, type Rig } from "../../types";
import { DentalOralSurface } from "../dental-oral-surface";

/**
 * The photographic teeth under a head turned in depth (dental-oral-
 * surface.ts with MouthSurfaceFrame.turn), on Skia's raster: the standard
 * teeth photo drawn into its own open mouth, frontal, under a turn of
 * nothing, and turned.
 */
const ASSETS = new URL("../../../assets/", import.meta.url);
const rig = JSON.parse(readFileSync(new URL("mouth-teeth.rig.json", ASSETS), "utf8")) as Rig;
const [W, H] = rig.image_size;
const points: MouthPoint[] = rig.points.map(([x, y]) => ({ x, y }));
const [left, right] = centralMouthAnchors(
  rig.inner_lip_ring.map((i) => points[i]),
  points[61],
  points[291]
);
/** A turn seen orthographically, 4.4 px per mm (this mouth is 50 mm). */
const turnOf = (yawDeg: number): MouthTurn => {
  const yaw = (yawDeg * Math.PI) / 180;
  return {
    yaw,
    pitch: 0,
    mm: 4.4,
    behindLips(out, x, y, depth) {
      out.x = x - depth * Math.sin(yaw);
      out.y = y;
      return out;
    },
  };
};

let surface: DentalOralSurface;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
  vi.stubGlobal("Path2D", Path2D);
  const image = (await loadImage(readFileSync(new URL("mouth-teeth.webp", ASSETS)))) as unknown as HTMLImageElement;
  surface = new DentalOralSurface({ image, rig });
});
afterAll(() => vi.unstubAllGlobals());

/** The mouth drawn into a canvas of the photo's size, `turn` given. */
function drawn(turn?: MouthTurn): Uint8ClampedArray {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#b07060";
  ctx.fillRect(0, 0, W, H);
  const frame = {
    points,
    neutral: points,
    rig,
    weights: { ...ZERO_WEIGHTS },
    viseme: "aa",
    lipColour: [160, 80, 74],
    turn,
  } as MouthSurfaceFrame;
  surface.draw(ctx, frame, left, right, 1);
  return ctx.getImageData(0, 0, W, H).data;
}

/** The mean x of the bright (enamel) pixels. */
function enamelX(data: Uint8ClampedArray): number {
  let sum = 0,
    count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] + data[i + 1] + data[i + 2] < 480) continue;
    sum += (i / 4) % W;
    count++;
  }
  expect(count).toBeGreaterThan(500);
  return sum / count;
}

describe("the photographic teeth, the head turned in depth", () => {
  it("are drawn exactly as frontal ones under a turn of nothing", () => {
    expect(Buffer.from(drawn(turnOf(0))).equals(Buffer.from(drawn()))).toBe(true);
  });

  it("lag the lips as the head turns, by about their depth", () => {
    const frontal = enamelX(drawn());
    // yaw + : the arch, 10 mm and more behind the lips, goes right less
    // than they do: here, with the lips held, it goes left by at least
    // 10 mm * sin(7 deg) = 5.4 px.
    const lag = 10 * 4.4 * Math.sin((7 * Math.PI) / 180);
    expect(frontal - enamelX(drawn(turnOf(7)))).toBeGreaterThan(lag * 0.9);
    expect(enamelX(drawn(turnOf(-7))) - frontal).toBeGreaterThan(lag * 0.9);
  });

  it("change little for a little turn", () => {
    const frontal = drawn();
    const slight = drawn(turnOf(0.001));
    let sum = 0;
    for (let i = 0; i < frontal.length; i++) sum += Math.abs(frontal[i] - slight[i]);
    expect(sum / frontal.length).toBeLessThan(0.01);
  });
});
