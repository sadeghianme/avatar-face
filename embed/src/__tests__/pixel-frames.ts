/**
 * The frames the pixel test holds to its goldens (pixels.test.ts): the real
 * engine on a software canvas (@napi-rs/canvas: Skia's CPU raster, in
 * Node), three committed subjects, a virtual clock. No test framework in
 * here, so a plain script can draw the same frames (on another CPU, say).
 *
 * The caller provides the browser: `document.createElement("canvas")`,
 * Path2D and ImageData from @napi-rs/canvas (installSkiaBrowser), a seeded
 * Math.random, and performance.now reading `clock.now`.
 */
import { readFileSync } from "node:fs";
import { ImageData, Path2D, createCanvas, loadImage } from "@napi-rs/canvas";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { MouthPose } from "../mouth-extension";
import { ZERO_WEIGHTS, type Cue, type Rig } from "../types";

export const SIZE = 256;
/** Cells per side of a frame's signature grids. */
export const GRID = 16;
const STEP = 16;

const FIXTURES = new URL("./fixtures/", import.meta.url);
const json = <T>(path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;
const human = json<Rig>("human-rig.json");
const animal = json<Rig>("fitted-animal-rig.json");
const cues = json<{ cues: Cue[] }>("native-cues-hello.json").cues;

export interface Subject {
  rig: Rig;
  /** A picture under fixtures/pixels/. */
  texture: string;
}

export const SUBJECTS: Record<string, Subject> = {
  /** A photo, the classic mouth with its teeth, the mesh blink. */
  human: { rig: human, texture: "pixels/reference-portrait.webp" },
  /** The same rig as a toon: the character mouth, painted lids. */
  toon: { rig: { ...human, render_profile: "toon@1" }, texture: "pixels/reference-portrait.webp" },
  /** A cut-out animal: the head as its own layer, no incisors. */
  animal: { rig: animal, texture: "pixels/animal-realistic.webp" },
};

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

/** A seeded Math.random (Park-Miller), the same sequence on every machine. */
export function seededRandom(seed = 7): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/**
 * `subject`'s eleven frames: at rest, four held shapes, four moments of a
 * real cue track, a blink mid-sweep, the whole picture on a background.
 * `clock.now` is the frame time; performance.now must read it.
 */
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

  // The mouth's box at rest, widened to the lips' surroundings.
  const lips = engine.landmarks().filter((_, i) => rig.outer_lip_ring.includes(i));
  const xs = lips.map((p) => p.x);
  const ys = lips.map((p) => p.y);
  const side = Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.6);
  const left = Math.min(SIZE - side, Math.max(0, Math.round((Math.max(...xs) + Math.min(...xs)) / 2 - side / 2)));
  const top = Math.min(SIZE - side, Math.max(0, Math.round((Math.max(...ys) + Math.min(...ys)) / 2 - side / 2)));
  const mouth: Drawn["mouth"] = [left, top, side, side];

  const frames: Drawn[] = [];
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += STEP;
      e.tick(clock.now);
    }
  };
  const capture = (name: string) => {
    e.render();
    const data = new Uint8ClampedArray(ctx.getImageData(0, 0, SIZE, SIZE).data);
    const png = canvas.toBuffer("image/png");
    frames.push({ name, data, mouth, png: () => png });
  };

  tick(60);
  capture("rest");
  for (const viseme of ["aa", "E", "ou", "PP"]) {
    pose.current = { viseme, weights: { ...ZERO_WEIGHTS, ...(rig.visemes[viseme] ?? {}) } };
    tick(40);
    capture(`held ${viseme}`);
  }
  pose.current = null;
  tick(40);
  engine.playCues(cues);
  const start = clock.now;
  const end = cues[cues.length - 1].t;
  for (const at of [0.2, 0.4, 0.6, 0.8]) {
    while (clock.now < start + Math.round((at * end) / STEP) * STEP) tick(1);
    capture(`speech ${Math.round(at * 100)}%`);
  }
  engine.stopSpeech();
  tick(30);
  e.face.blink = 0.5;
  capture("blink");
  e.face.blink = 0;
  engine.setScene({ zoom: 0, pan: { x: 0.05, y: -0.03 }, background: { kind: "color", color: "#204060" } });
  tick(1);
  capture("whole picture on a background");
  engine.destroy();
  return frames;
}

/** Mean RGBA over a GRID x GRID grid of the box (x, y, w, h) of a frame. */
export function grid(data: Uint8ClampedArray, box: readonly [number, number, number, number], cells = GRID): Uint8Array {
  const [bx, by, bw, bh] = box;
  const out = new Uint8Array(cells * cells * 4);
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const x0 = Math.floor(bx + (gx * bw) / cells);
      const x1 = Math.floor(bx + ((gx + 1) * bw) / cells);
      const y0 = Math.floor(by + (gy * bh) / cells);
      const y1 = Math.floor(by + ((gy + 1) * bh) / cells);
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * SIZE + x) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[i + c];
          n++;
        }
      }
      for (let c = 0; c < 4; c++) out[(gy * cells + gx) * 4 + c] = Math.round(sum[c] / Math.max(1, n));
    }
  }
  return out;
}

/** The largest and the mean absolute difference between two grids. */
export function drift(a: Uint8Array, b: Uint8Array): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: sum / a.length };
}
