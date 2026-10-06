/**
 * The frames every pixel test draws, wherever it draws them: on Skia's CPU
 * raster in Node (pixel-frames.ts, pixels.test.ts) and in Chromium, on the
 * GPU path and the 2D one (browser-tests/). Nothing in here touches Node or
 * the DOM: the caller provides the canvas, the texture, a clock that
 * performance.now reads, and a seeded Math.random (seededRandom).
 */
import type { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { MouthPose } from "../mouth-extension";
import { ZERO_WEIGHTS, type Cue, type Rig } from "../types";

/** The canvas's side, in pixels. */
export const SIZE = 256;
/** Cells per side of a frame's signature grids. */
export const GRID = 16;
/** One frame's step, in ms. */
const STEP = 16;

/** The committed subjects, as files under src/__tests__/fixtures/. */
export const SUBJECT_FILES: Record<string, { rig: string; profile?: string; texture: string }> = {
  /** A photo, the classic mouth with its teeth, the mesh blink. */
  human: { rig: "human-rig.json", texture: "pixels/reference-portrait.webp" },
  /** The same rig as a toon: the character mouth, painted lids. */
  toon: { rig: "human-rig.json", profile: "toon@1", texture: "pixels/reference-portrait.webp" },
  /** A cut-out animal: the head as its own layer, no incisors. */
  animal: { rig: "fitted-animal-rig.json", texture: "pixels/animal-realistic.webp" },
};
/** The cue track the speech frames play. */
export const CUES_FILE = "native-cues-hello.json";

/** A subject's rig as the engine gets it: its line's profile applied. */
export function subjectRig(name: string, rig: Rig): Rig {
  const profile = SUBJECT_FILES[name].profile;
  return structuredClone(profile ? { ...rig, render_profile: profile } : rig);
}

/** A seeded Math.random (Park-Miller), the same sequence on every machine. */
export function seededRandom(seed = 7): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/**
 * The script: at rest, four held shapes, four moments of a real cue track,
 * a blink mid-sweep, the whole picture on a background. `capture(name)`
 * is called once a frame is set up, to draw it (through the seam's render)
 * and read it. `clock.now` is the frame time. Returns the mouth's box at
 * rest (x, y, width, height), widened to the lips' surroundings.
 */
export async function playFrameScript(
  engine: AvatarEngine,
  rig: Rig,
  cues: Cue[],
  clock: { now: number },
  pose: { current: MouthPose | null },
  capture: (name: string) => void | Promise<void>
): Promise<[number, number, number, number]> {
  const e = engineSeam(engine);
  const lips = engine.landmarks().filter((_, i) => rig.outer_lip_ring.includes(i));
  const xs = lips.map((p) => p.x);
  const ys = lips.map((p) => p.y);
  const side = Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.6);
  const left = Math.min(SIZE - side, Math.max(0, Math.round((Math.max(...xs) + Math.min(...xs)) / 2 - side / 2)));
  const top = Math.min(SIZE - side, Math.max(0, Math.round((Math.max(...ys) + Math.min(...ys)) / 2 - side / 2)));

  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      clock.now += STEP;
      e.tick(clock.now);
    }
  };

  tick(60);
  await capture("rest");
  for (const viseme of ["aa", "E", "ou", "PP"]) {
    pose.current = { viseme, weights: { ...ZERO_WEIGHTS, ...(rig.visemes[viseme] ?? {}) } };
    tick(40);
    await capture(`held ${viseme}`);
  }
  pose.current = null;
  tick(40);
  engine.playCues(cues);
  const start = clock.now;
  const end = cues[cues.length - 1].t;
  for (const at of [0.2, 0.4, 0.6, 0.8]) {
    while (clock.now < start + Math.round((at * end) / STEP) * STEP) tick(1);
    await capture(`speech ${Math.round(at * 100)}%`);
  }
  engine.stopSpeech();
  tick(30);
  e.face.blink = 0.5;
  await capture("blink");
  e.face.blink = 0;
  engine.setScene({ zoom: 0, pan: { x: 0.05, y: -0.03 }, background: { kind: "color", color: "#204060" } });
  tick(1);
  await capture("whole picture on a background");
  return [left, top, side, side];
}

/** Mean RGBA over a `cells` x `cells` grid of the box (x, y, w, h) of a frame. */
export function grid(
  data: Uint8ClampedArray,
  box: readonly [number, number, number, number],
  cells = GRID
): Uint8Array {
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
