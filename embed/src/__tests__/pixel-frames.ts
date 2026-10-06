/**
 * The frames the pixel test holds to its goldens (pixels.test.ts): the real
 * engine on a software canvas (@napi-rs/canvas: Skia's CPU raster, in
 * Node), the committed subjects and the script of frame-script.ts, on a
 * virtual clock. No test framework in here, so a plain script can draw the
 * same frames (on another CPU, say).
 *
 * The caller provides the browser: `document.createElement("canvas")`,
 * Path2D and ImageData from @napi-rs/canvas (SKIA_BROWSER), a seeded
 * Math.random, and performance.now reading `clock.now`.
 */
import { readFileSync } from "node:fs";
import { ImageData, Path2D, createCanvas, loadImage } from "@napi-rs/canvas";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { MouthPose } from "../mouth-extension";
import type { Cue, Rig } from "../types";
import { CUES_FILE, SIZE, SUBJECT_FILES, playFrameScript, subjectRig } from "./frame-script";

export { GRID, SIZE, drift, grid, seededRandom } from "./frame-script";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const json = <T>(path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;
const cues = json<{ cues: Cue[] }>(CUES_FILE).cues;

export interface Subject {
  rig: Rig;
  /** A picture under fixtures/pixels/. */
  texture: string;
}

export const SUBJECTS: Record<string, Subject> = Object.fromEntries(
  Object.entries(SUBJECT_FILES).map(([name, files]) => [name, { rig: subjectRig(name, json<Rig>(files.rig)), texture: files.texture }])
);

/** One frame drawn: its name, its pixels and where the mouth is. */
export interface Drawn {
  name: string;
  /** RGBA, SIZE x SIZE. */
  data: Uint8ClampedArray;
  /** The mouth's box at rest, x, y, width, height (square). */
  mouth: [number, number, number, number];
  png: () => Buffer;
}

/** The globals the engine reaches for, as a browser has them. */
export const SKIA_BROWSER = {
  document: { createElement: (tag: string) => (tag === "canvas" ? createCanvas(300, 150) : {}) },
  Path2D,
  ImageData,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => undefined,
};

/** `subject`'s eleven frames (frame-script.ts). `clock.now` is the frame
 *  time; performance.now must read it. */
export async function drawFrames(subject: Subject, clock: { now: number }): Promise<Drawn[]> {
  const texture = await loadImage(readFileSync(new URL(subject.texture, FIXTURES)));
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  const pose: { current: MouthPose | null } = { current: null };
  const rig = structuredClone(subject.rig);
  const engine = new AvatarEngine(canvas as unknown as HTMLCanvasElement, rig, texture as unknown as HTMLImageElement, {
    warp: "2d",
    pose: () => pose.current,
  });
  const e = engineSeam(engine);
  const frames: Omit<Drawn, "mouth">[] = [];
  const mouth = await playFrameScript(engine, rig, cues, clock, pose, (name) => {
    e.render();
    const data = new Uint8ClampedArray(ctx.getImageData(0, 0, SIZE, SIZE).data);
    const png = canvas.toBuffer("image/png");
    frames.push({ name, data, png: () => png });
  });
  engine.destroy();
  return frames.map((frame) => ({ ...frame, mouth }));
}
