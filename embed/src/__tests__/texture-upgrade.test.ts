import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { CHEEK_LANDMARKS } from "../engine/landmarks";
import { engineSeam } from "../engine/seam";
import type { MouthExtension, MouthSurfaceFrame } from "../mouth-extension";
import type { Rig } from "../types";
import { NoopPath, paintedImage, readingCanvas, type PaintedImage, type Pixel } from "./browser-fakes";

/**
 * The widget's texture upgrade (setTexture): it boots on the 256 px
 * thumbnail and swaps in the full picture when that lands. What the engine
 * reads from a picture (the lips' and the skin's colours, the highlight,
 * the sharpness, the lashes and lids, the character look) must be read
 * from the full picture at ITS landmarks, not at the thumbnail's: after the
 * swap the engine must be what it would have been had it loaded the full
 * picture directly.
 */

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const [RIG_W, RIG_H] = rig.image_size;

const THUMB_LIP: Pixel = [180, 60, 72, 255];
const FULL_LIP: Pixel = [196, 48, 66, 255];
const SKIN: Pixel = [214, 168, 140, 255];

/** Which rig pixels are lip (1) and cheek (2): discs about those landmarks. */
const regions = (() => {
  const mask = new Uint8Array(RIG_W * RIG_H);
  const disc = (index: number, radius: number, value: number) => {
    const [cx, cy] = rig.points[index];
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (x < 0 || y < 0 || x >= RIG_W || y >= RIG_H) continue;
        if (Math.hypot(x - cx, y - cy) <= radius) mask[y * RIG_W + x] = value;
      }
    }
  };
  for (const i of rig.mouth_indices) disc(i, 7, 1);
  for (const i of CHEEK_LANDMARKS) disc(i, 12, 2);
  return mask;
})();

/**
 * One photograph at `width` px wide: lips and cheeks of their own colours,
 * everything else a colour that changes with position (so a sample taken
 * at the wrong place reads something else). The thumbnail's lips are a
 * shade off the full picture's, as a small JPEG's are.
 */
function picture(width: number, lip: Pixel): PaintedImage {
  const height = Math.round((width * RIG_H) / RIG_W);
  const k = RIG_W / width;
  return paintedImage(width, height, (x, y) => {
    const rx = Math.min(RIG_W - 1, Math.max(0, Math.floor((x + 0.5) * k)));
    const ry = Math.min(RIG_H - 1, Math.max(0, Math.floor((y + 0.5) * k)));
    const region = regions[ry * RIG_W + rx];
    if (region === 1) return lip;
    if (region === 2) return SKIN;
    return [(rx * 3 + ry) % 256, (rx + ry * 5) % 256, (rx * 7 + ry * 11) % 256, 255];
  });
}

/** A mouth renderer that only records what the engine hands it to paint with. */
function recordingMouth(): MouthExtension & { seen: MouthSurfaceFrame | null } {
  const mouth = {
    seen: null as MouthSurfaceFrame | null,
    paint(_ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame) {
      mouth.seen = frame;
      return true;
    },
    draw() {},
  };
  return mouth;
}

/** What a mouth renderer is handed, minus the mesh (compared on its own). */
const paintedWith = (frame: MouthSurfaceFrame | null) => {
  if (!frame) throw new Error("the mouth was not painted");
  const { lipColour, skinColour, faceHighlight, soft, sharpness, pixelScale } = frame;
  return { lipColour, skinColour, faceHighlight, soft, sharpness, pixelScale };
};

describe("the texture upgrade", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => readingCanvas() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const thumbnail = picture(256, THUMB_LIP);
  const full = picture(RIG_W, FULL_LIP);
  const engineOn = (texture: PaintedImage) => new AvatarEngine(readingCanvas(512), rig, texture, { fullPhoto: false });

  it("reads the full picture's lips and cheeks from where they are in it", () => {
    const engine = engineOn(thumbnail);
    const samples = engineSeam(engine).samples;
    expect(samples.lipColour).toEqual(THUMB_LIP.slice(0, 3));
    expect(samples.skinColour).toEqual(SKIN.slice(0, 3));
    engine.setTexture(full);
    // The thumbnail's landmarks lie in the full picture's top-left fifth,
    // nowhere near its lips: read there, the colours are the background's.
    expect(samples.lipColour).toEqual(FULL_LIP.slice(0, 3));
    expect(samples.skinColour).toEqual(SKIN.slice(0, 3));
    engine.destroy();
  });

  it("ends where loading the full picture directly would have", () => {
    const upgraded = engineOn(thumbnail);
    upgraded.setTexture(full);
    const direct = engineOn(full);
    const a = engineSeam(upgraded), b = engineSeam(direct);
    // Everything read from the picture: colours, highlight, sharpness,
    // lashes, lids, the character look.
    expect(a.samples).toEqual(b.samples);
    expect(a.samples.faceSharpness).not.toBeNull();
    expect(a.mesh).toEqual(b.mesh);
    // And what a mouth renderer is handed to paint with.
    const seen = [upgraded, direct].map((engine) => {
      const mouth = recordingMouth();
      engine.setMouthExtension(mouth);
      engineSeam(engine).render();
      return paintedWith(mouth.seen);
    });
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0].lipColour).toEqual(FULL_LIP.slice(0, 3));
    upgraded.destroy();
    direct.destroy();
  });
});
