/**
 * The page side of gl-warp.test.ts and seams.test.ts: the engine from
 * source, drawing the pixel tests' frames (src/__tests__/frame-script.ts)
 * and the seam tests' (src/__tests__/seam-script.ts) in a real browser, on
 * the GPU path (WebGL, engine/warp-gl.ts) or the forced 2D one, on a
 * virtual clock and a seeded random. Bundled by esbuild for the test and
 * served beside the fixtures.
 */
import { AvatarEngine } from "../src/engine";
import { engineSeam } from "../src/engine/seam";
import type { WarpMode } from "../src/engine/mesh-warp";
import type { MouthPose } from "../src/mouth-extension";
import type { Cue, Rig } from "../src/types";
import {
  CUES_FILE,
  SIZE,
  SUBJECT_FILES,
  playFrameScript,
  seededRandom,
  subjectRig,
} from "../src/__tests__/frame-script";
import { probeSeams, type SeamReport } from "../src/__tests__/seam-probe";
import { SEAM_SIZE, headLayerFade, paintCollar, playSeamScript } from "../src/__tests__/seam-script";

/** One frame drawn: its name, the path the warp took, its RGBA (base64). */
export interface PageFrame {
  name: string;
  path: "gl" | "2d";
  rgba: string;
}

/** One seam-test frame: its name, the path the warp took, what the probe
 *  found, and the share of the turn the fold clamp kept. */
export interface SeamPageFrame {
  name: string;
  path: "gl" | "2d";
  report: SeamReport;
  scale: number;
}

declare global {
  interface Window {
    drawSubject(
      name: string,
      warp: WarpMode
    ): Promise<{ frames: PageFrame[]; mouth: [number, number, number, number] }>;
    seamSubject(layered: boolean, warp: WarpMode): Promise<SeamPageFrame[]>;
  }
}

const fixture = async <T>(path: string): Promise<T> => {
  const response = await fetch(`/fixtures/${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
};

const picture = (path: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${path} did not load`));
    img.src = `/fixtures/${path}`;
  });

function base64(bytes: Uint8ClampedArray): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

window.drawSubject = async (name, warp) => {
  const clock = { now: 10_000 };
  Math.random = seededRandom();
  performance.now = () => clock.now;
  // The script steps the engine itself; the frame loop must not.
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => undefined;

  const files = SUBJECT_FILES[name];
  const rig = subjectRig(name, await fixture<Rig>(files.rig));
  const cues = (await fixture<{ cues: Cue[] }>(CUES_FILE)).cues;
  const texture = await picture(files.texture);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const pose: { current: MouthPose | null } = { current: null };
  const engine = new AvatarEngine(canvas, rig, texture, { warp, pose: () => pose.current });
  const e = engineSeam(engine);
  const ctx = canvas.getContext("2d")!;
  const frames: PageFrame[] = [];
  const mouth = await playFrameScript(engine, rig, cues, clock, pose, (frame) => {
    e.render();
    frames.push({ name: frame, path: engine.warpPath(), rgba: base64(ctx.getImageData(0, 0, SIZE, SIZE).data) });
  });
  engine.destroy();
  return { frames, mouth };
};

/** An image from a canvas, as a layer or a texture is loaded. */
const imageOf = (canvas: HTMLCanvasElement) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("a canvas did not load as an image"));
    img.src = canvas.toDataURL("image/png");
  });

window.seamSubject = async (layered, warp) => {
  const clock = { now: 10_000 };
  Math.random = seededRandom();
  performance.now = () => clock.now;
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => undefined;

  const rig = await fixture<Rig>("human-rig.json");
  const cues = (await fixture<{ cues: Cue[] }>(CUES_FILE)).cues;
  const portrait = await picture("pixels/reference-portrait.webp");
  // The photo with a striped collar, and a head layer from it faded out
  // down the neck (seam-script.ts).
  const photo = document.createElement("canvas");
  photo.width = portrait.naturalWidth;
  photo.height = portrait.naturalHeight;
  const p = photo.getContext("2d")!;
  p.drawImage(portrait, 0, 0);
  paintCollar(rig, photo.width, photo.height, (x, y, w, h) => {
    p.fillStyle = "#1a1f2e";
    p.fillRect(x, y, w, h);
  });
  const texture = await imageOf(photo);
  const [y0, y1] = headLayerFade(rig, photo.height);
  const head = document.createElement("canvas");
  head.width = photo.width;
  head.height = photo.height;
  const g = head.getContext("2d")!;
  g.drawImage(texture, 0, 0);
  g.globalCompositeOperation = "destination-in";
  const fade = g.createLinearGradient(0, y0, 0, y1);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = fade;
  g.fillRect(0, 0, head.width, head.height);
  const headLayer = await imageOf(head);

  const canvas = document.createElement("canvas");
  canvas.width = SEAM_SIZE;
  canvas.height = SEAM_SIZE;
  const engine = new AvatarEngine(canvas, rig, texture, { warp });
  if (layered) engine.setLayers({ body: texture, head: headLayer });
  const ctx = canvas.getContext("2d")!;
  const frames = await playSeamScript(engine, cues, clock, () => ctx.getImageData(0, 0, SEAM_SIZE, SEAM_SIZE).data);
  const path = engine.warpPath();
  engine.destroy();
  return frames.map((f) => ({
    name: f.name,
    path,
    report: probeSeams(f.frame, f.under, SEAM_SIZE, f.segments),
    scale: f.scale,
  }));
};
