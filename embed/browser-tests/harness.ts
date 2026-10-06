/**
 * The page side of gl-warp.test.ts: the engine from source, drawing the
 * pixel tests' frames (src/__tests__/frame-script.ts) in a real browser, on
 * the GPU path (WebGL, engine/warp-gl.ts) or the forced 2D one, on a
 * virtual clock and a seeded random. Bundled by esbuild for the test and
 * served beside the fixtures.
 */
import { AvatarEngine } from "../src/engine";
import { engineSeam } from "../src/engine/seam";
import type { WarpMode } from "../src/engine/mesh-warp";
import type { MouthPose } from "../src/mouth-extension";
import type { Cue, Rig } from "../src/types";
import { CUES_FILE, SIZE, SUBJECT_FILES, playFrameScript, seededRandom, subjectRig } from "../src/__tests__/frame-script";

/** One frame drawn: its name, the path the warp took, its RGBA (base64). */
export interface PageFrame {
  name: string;
  path: "gl" | "2d";
  rgba: string;
}

declare global {
  interface Window {
    drawSubject(name: string, warp: WarpMode): Promise<{ frames: PageFrame[]; mouth: [number, number, number, number] }>;
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
