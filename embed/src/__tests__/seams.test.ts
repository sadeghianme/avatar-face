import { readFileSync } from "node:fs";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import type { Cue, Rig } from "../types";
import { seededRandom } from "./frame-script";
import { SKIA_BROWSER } from "./pixel-frames";
import { probeSeams } from "./seam-probe";
import { SEAM_SIZE, headLayerFade, paintCollar, playSeamScript } from "./seam-script";

/**
 * No seam where the turned face meets the picture around it, in real
 * pixels (Skia's CPU raster, the 2D warp; the browser test holds the GPU
 * warp to the same): the committed human photo, its head turned in depth
 * to every corner of its limits and mid-sentence, as an opaque photo and as
 * a layered avatar whose head layer fades out down the neck. Along the
 * face's outline and the neck band's bottom edge (seam-probe.ts) the frame
 * continues what the canvas held before the mesh was drawn: no line, no
 * step, and the whole turn kept (the fold clamp never engaged).
 */
const FIXTURES = new URL("./fixtures/", import.meta.url);
const rig = JSON.parse(readFileSync(new URL("human-rig.json", FIXTURES), "utf8")) as Rig;
const cues = (JSON.parse(readFileSync(new URL("native-cues-hello.json", FIXTURES), "utf8")) as { cues: Cue[] }).cues;
let texture: Image;
let head: Image;

beforeAll(async () => {
  const portrait = await loadImage(readFileSync(new URL("pixels/reference-portrait.webp", FIXTURES)));
  // The photo with a striped collar under the chin (seam-script.ts).
  const photo = createCanvas(portrait.width, portrait.height);
  const p = photo.getContext("2d");
  p.drawImage(portrait, 0, 0);
  paintCollar(rig, portrait.width, portrait.height, (x, y, w, h) => {
    p.fillStyle = "#1a1f2e";
    p.fillRect(x, y, w, h);
  });
  texture = await loadImage(photo.toBuffer("image/png"));
  // A head layer from it: whole down to under the chin, faded out down the
  // neck.
  const [y0, y1] = headLayerFade(rig, texture.height);
  const c = createCanvas(texture.width, texture.height);
  const g = c.getContext("2d");
  g.drawImage(texture, 0, 0);
  g.globalCompositeOperation = "destination-in";
  const fade = g.createLinearGradient(0, y0, 0, y1);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, texture.width, texture.height);
  head = await loadImage(c.toBuffer("image/png"));
});

describe("the turned face's seams, on Skia", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockImplementation(seededRandom());
    for (const [name, value] of Object.entries(SKIA_BROWSER)) vi.stubGlobal(name, value);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const layered of [false, true]) {
    it(`are none on ${layered ? "a layered avatar" : "an opaque photo"}`, async () => {
      const clock = { now: 10_000 };
      vi.spyOn(performance, "now").mockImplementation(() => clock.now);
      const canvas = createCanvas(SEAM_SIZE, SEAM_SIZE);
      const ctx = canvas.getContext("2d");
      const engine = new AvatarEngine(
        canvas as unknown as HTMLCanvasElement,
        structuredClone(rig),
        texture as unknown as HTMLImageElement,
        { warp: "2d" }
      );
      expect(engine.headMotion()).toBe("3d");
      if (layered) {
        engine.setLayers({
          body: texture as unknown as HTMLImageElement,
          head: head as unknown as HTMLImageElement,
        });
      }
      const frames = await playSeamScript(
        engine,
        cues,
        clock,
        () => new Uint8ClampedArray(ctx.getImageData(0, 0, SEAM_SIZE, SEAM_SIZE).data)
      );
      engine.destroy();
      const found = frames.map((f) => {
        const r = probeSeams(f.frame, f.under, SEAM_SIZE, f.segments);
        // Seams and tears by the detector's own thresholds (4 and 16 levels
        // over a run), and, stricter, no run stepped by more than 3 levels
        // (the band a pixel off its collar steps it by 10).
        const ok = r.seams === 0 && r.tears === 0 && r.worstStep <= 3 && f.scale === 1;
        return `${f.name}: ${ok ? "clean" : "SEAM"} (${r.seams} seams, ${r.tears} tears of ${r.runs}; worst line ${r.worstLine.toFixed(1)}, step ${r.worstStep.toFixed(1)}; turn kept ${f.scale})`;
      });
      expect(frames.every((f) => f.segments.some((s) => s.kind === "neck"))).toBe(true);
      expect(found).toEqual(frames.map((f) => expect.stringMatching(new RegExp(`^${f.name}: clean `))));
    }, 60_000);
  }
});
