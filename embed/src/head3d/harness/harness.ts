/**
 * The head3d harness page: loads a GLB into the real 3D engine and renders
 * what the spike has to judge — viseme stills at several yaws, a phrase, a
 * side-by-side with the 2D engine's frontal render, and a frame-time
 * measurement. Driven from the page's query string (a look in a browser)
 * or by headless.mjs over the DevTools protocol (`window.__head3d.run`).
 *
 * A lab page: it reaches into both engines the way the golden tests do
 * (private state through a cast) to hold a still; the product never does.
 */
import * as THREE from "three";

import { AvatarEngine } from "../../engine";
import type { Avatar3DEngine } from "../../engine3d";
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type Rig } from "../../types";
import { expandVisemeTable, type Head3DExtras } from "../extras";
import { FixedHeadPose } from "../head-pose";
import { loadHead3D } from "../load";

interface SheetSpec {
  mode: "sheet";
  glb: string;
  visemes?: string[];
  yaws?: number[];
  cell?: number;
  label?: string;
}
interface CompareSpec {
  mode: "compare";
  glb: string;
  rig: string;
  image: string;
  visemes?: string[];
  cell?: number;
  label?: string;
}
interface PhraseSpec {
  mode: "phrase";
  glb: string;
  rig?: string;
  image?: string;
  cell?: number;
  label?: string;
  /** Frames per second of the strip and ms between the frames kept. */
  every?: number;
}
interface BenchSpec {
  mode: "bench";
  glb: string;
  frames?: number;
  size?: number;
}
type Spec = SheetSpec | CompareSpec | PhraseSpec | BenchSpec;

const VISEME_LABELS: Record<string, string> = {
  sil: "rest", aa: "aa", E: "ee", ou: "oo", oh: "oh", FF: "fv", TH: "th",
};
const DEFAULT_VISEMES = ["sil", "aa", "E", "ou", "oh", "FF", "TH"];
const DEFAULT_YAWS = [-20, 0, 20];

/** "Hello, how are you today? I am a three dee head." as a cue track. */
export const PHRASE_CUES: Cue[] = [
  { t: 0, viseme: "sil" }, { t: 120, viseme: "kk" }, { t: 200, viseme: "E" }, { t: 330, viseme: "nn" },
  { t: 420, viseme: "oh" }, { t: 560, viseme: "sil" }, { t: 700, viseme: "kk" }, { t: 780, viseme: "aa" },
  { t: 900, viseme: "ou" }, { t: 1000, viseme: "aa" }, { t: 1120, viseme: "RR" }, { t: 1220, viseme: "ih" },
  { t: 1320, viseme: "ou" }, { t: 1460, viseme: "TH" }, { t: 1540, viseme: "ou" }, { t: 1640, viseme: "DD" },
  { t: 1720, viseme: "E" }, { t: 1900, viseme: "sil" }, { t: 2100, viseme: "aa" }, { t: 2220, viseme: "ih" },
  { t: 2330, viseme: "PP" }, { t: 2420, viseme: "aa" }, { t: 2560, viseme: "TH" }, { t: 2640, viseme: "RR" },
  { t: 2740, viseme: "E" }, { t: 2900, viseme: "DD" }, { t: 2980, viseme: "E" }, { t: 3120, viseme: "kk" },
  { t: 3200, viseme: "E" }, { t: 3340, viseme: "DD" }, { t: 3480, viseme: "sil" }, { t: 3800, viseme: "sil" },
];

const view = document.getElementById("view") as HTMLCanvasElement;
const sheet = document.getElementById("sheet") as HTMLCanvasElement;
const log = document.getElementById("log") as HTMLPreElement;
const say = (text: string) => { log.textContent += text + "\n"; };

/** Time as the engines see it: virtual for stills and phrases, real for the bench. */
let virtualNow: number | null = null;
const realNow = performance.now.bind(performance);
performance.now = () => (virtualNow ?? realNow());

interface Loaded {
  engine: Avatar3DEngine;
  extras: Head3DExtras | null;
  pose: FixedHeadPose;
  table: Record<string, Record<string, number>>;
  renderer: THREE.WebGLRenderer;
}

async function load(url: string, size: number, fixed = true): Promise<Loaded> {
  view.width = size;
  view.height = size;
  delete view.dataset.lfBaseW;
  delete view.dataset.lfBaseH;
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true, alpha: true, preserveDrawingBuffer: true });
  const pose = new FixedHeadPose();
  const { engine, extras } = await loadHead3D(view, url, fixed ? { headPose: pose } : {}, renderer);
  const table = extras ? expandVisemeTable(extras.visemes) : {};
  return { engine, extras, pose, table, renderer };
}

type Engine2DInternals = { weights: BlendWeights; tick(now: number): void; render(): void };

async function load2D(rigUrl: string, imageUrl: string, size: number): Promise<{ engine: AvatarEngine; canvas: HTMLCanvasElement; rig: Rig }> {
  const rig = (await (await fetch(rigUrl)).json()) as Rig;
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`cannot load ${imageUrl}`));
    image.src = imageUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const engine = new AvatarEngine(canvas, rig, image, { fullPhoto: false });
  engine.tuning.headMotion = 0;
  engine.tuning.bodyMotion = 0;
  return { engine, canvas, rig };
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 14): void {
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const w = ctx.measureText(text).width + 10;
  ctx.fillRect(x, y, w, size + 8);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 5, y + size + 1);
}

/** The engine's own name for a viseme's shape target (engine3d's map). */
const VISEME_MORPH: Record<string, string> = {
  sil: "viseme_sil", PP: "viseme_PP", FF: "viseme_FF", TH: "viseme_TH", DD: "viseme_DD", kk: "viseme_kk",
  CH: "viseme_CH", SS: "viseme_SS", nn: "viseme_nn", RR: "viseme_RR", aa: "viseme_aa", E: "viseme_E",
  ih: "viseme_I", oh: "viseme_O", ou: "viseme_U",
};

function still(loaded: Loaded, viseme: string, yawDeg: number): void {
  loaded.pose.set(yawDeg);
  // The viseme's own shape when the head carries it (exact), else the
  // ARKit decomposition at the table's weights.
  const shape = VISEME_MORPH[viseme];
  const hasShape = loaded.extras?.morphs.includes(shape) ?? false;
  loaded.engine.holdMorphs(hasShape ? { [shape]: 1 } : loaded.table[viseme] ?? {});
  // Early in the engine's life: before its first blink or saccade.
  virtualNow = 10_100;
  loaded.engine.step(virtualNow);
}

async function runSheet(spec: SheetSpec): Promise<string> {
  const cell = spec.cell ?? 300;
  const visemes = spec.visemes ?? DEFAULT_VISEMES;
  const yaws = spec.yaws ?? DEFAULT_YAWS;
  virtualNow = 10_000;
  const loaded = await load(spec.glb, cell);
  sheet.width = cell * visemes.length;
  sheet.height = cell * yaws.length + 24;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#2a2a30";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  label(ctx, spec.label ?? spec.glb, 4, 2);
  yaws.forEach((yaw, r) => {
    visemes.forEach((viseme, c) => {
      still(loaded, viseme, yaw);
      ctx.drawImage(view, c * cell, 24 + r * cell, cell, cell);
      label(ctx, `${VISEME_LABELS[viseme] ?? viseme}  yaw ${yaw}`, c * cell + 4, 24 + r * cell + 4, 12);
    });
  });
  loaded.engine.destroy();
  return sheet.toDataURL("image/png");
}

async function runCompare(spec: CompareSpec): Promise<string> {
  const cell = spec.cell ?? 300;
  const visemes = spec.visemes ?? DEFAULT_VISEMES;
  virtualNow = 10_000;
  const loaded = await load(spec.glb, cell);
  const flat = await load2D(spec.rig, spec.image, cell);
  const e2 = flat.engine as unknown as Engine2DInternals;
  sheet.width = cell * visemes.length;
  sheet.height = cell * 2 + 24;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#2a2a30";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  label(ctx, `${spec.label ?? spec.glb}: 2D engine (top) vs 3D head (bottom), frontal`, 4, 2);
  visemes.forEach((viseme, c) => {
    e2.weights = { ...ZERO_WEIGHTS, ...(flat.rig.visemes[viseme] ?? {}) };
    e2.render();
    ctx.drawImage(flat.canvas, c * cell, 24, cell, cell);
    label(ctx, `2D ${VISEME_LABELS[viseme] ?? viseme}`, c * cell + 4, 28, 12);
    still(loaded, viseme, 0);
    ctx.drawImage(view, c * cell, 24 + cell, cell, cell);
    label(ctx, `3D ${VISEME_LABELS[viseme] ?? viseme}`, c * cell + 4, 28 + cell, 12);
  });
  loaded.engine.destroy();
  flat.engine.destroy();
  return sheet.toDataURL("image/png");
}

async function runPhrase(spec: PhraseSpec): Promise<string> {
  const cell = spec.cell ?? 220;
  const every = spec.every ?? 160;
  const frameMs = 1000 / 60;
  virtualNow = 10_000;
  const loaded = await load(spec.glb, cell, false);
  const flat = spec.rig && spec.image ? await load2D(spec.rig, spec.image, cell) : null;
  const e2 = flat ? (flat.engine as unknown as Engine2DInternals) : null;
  const duration = PHRASE_CUES[PHRASE_CUES.length - 1].t;
  const frames = Math.floor(duration / every) + 1;
  const rows = flat ? 2 : 1;
  sheet.width = cell * frames;
  sheet.height = cell * rows + 24;
  const ctx = sheet.getContext("2d")!;
  ctx.fillStyle = "#2a2a30";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  label(ctx, `${spec.label ?? spec.glb}: "Hello, how are you today? I am a 3D head." every ${every} ms${flat ? " (2D above, 3D below)" : ""}`, 4, 2);
  loaded.engine.playCues(PHRASE_CUES);
  flat?.engine.playCues(PHRASE_CUES);
  let next = 0;
  let column = 0;
  for (let t = 0; t <= duration + frameMs; t += frameMs) {
    virtualNow = 10_000 + t;
    loaded.engine.step(virtualNow);
    if (e2) {
      e2.tick(virtualNow);
      e2.render();
    }
    if (t >= next && column < frames) {
      if (flat) {
        ctx.drawImage(flat.canvas, column * cell, 24, cell, cell);
        label(ctx, `2D ${Math.round(t)} ms`, column * cell + 4, 28, 11);
      }
      ctx.drawImage(view, column * cell, 24 + (rows - 1) * cell, cell, cell);
      label(ctx, `3D ${Math.round(t)} ms`, column * cell + 4, 28 + (rows - 1) * cell, 11);
      column++;
      next += every;
    }
  }
  loaded.engine.destroy();
  flat?.engine.destroy();
  return sheet.toDataURL("image/png");
}

async function runBench(spec: BenchSpec): Promise<Record<string, unknown>> {
  const frames = spec.frames ?? 240;
  virtualNow = null;
  const loaded = await load(spec.glb, spec.size ?? 640, false);
  const gl = loaded.renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  loaded.engine.playCues(PHRASE_CUES);
  // A frame is not over until its pixels exist: reading one back forces
  // the GPU (or SwiftShader) to finish, which gl.finish() alone does not
  // guarantee across Chrome's GPU process.
  const pixel = new Uint8Array(4);
  const complete = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  // Warm up: shaders compile on the first frames.
  for (let i = 0; i < 10; i++) {
    loaded.engine.step(realNow());
    complete();
  }
  const times: number[] = [];
  const wallStart = realNow();
  for (let i = 0; i < frames; i++) {
    if (!loaded.engine.isSpeaking()) loaded.engine.playCues(PHRASE_CUES);
    const start = realNow();
    loaded.engine.step(realNow());
    complete();
    times.push(realNow() - start);
  }
  const wall = realNow() - wallStart;
  const stats = loaded.engine.stats();
  times.sort((a, b) => a - b);
  const mean = wall / frames;
  loaded.engine.destroy();
  return {
    gpu,
    frames,
    size: spec.size ?? 640,
    msMean: +mean.toFixed(2),
    msMedian: +times[Math.floor(times.length / 2)].toFixed(2),
    msP95: +times[Math.floor(times.length * 0.95)].toFixed(2),
    fps: +(1000 / mean).toFixed(1),
    drawCalls: stats.calls,
    triangles: stats.triangles,
  };
}

async function run(spec: Spec): Promise<unknown> {
  say(`run ${spec.mode} ${spec.glb}`);
  switch (spec.mode) {
    case "sheet": return runSheet(spec);
    case "compare": return runCompare(spec);
    case "phrase": return runPhrase(spec);
    case "bench": return runBench(spec);
  }
}

declare global {
  interface Window { __head3d: { run(spec: Spec): Promise<unknown> } }
}
window.__head3d = { run };

// A look in a browser: ?glb=/subjects/x.glb[&mode=sheet|phrase|bench][&rig=&image=]
const params = new URLSearchParams(location.search);
const glb = params.get("glb");
if (glb) {
  const mode = params.get("mode") ?? "view";
  if (mode === "view") {
    virtualNow = null;
    load(glb, 640, false).then(({ engine }) => {
      say("loaded; press space to speak");
      window.addEventListener("keydown", (ev) => {
        if (ev.key === " ") engine.playCues(PHRASE_CUES);
      });
    }, (err) => say(String(err)));
  } else {
    const spec = {
      mode, glb, rig: params.get("rig") ?? undefined, image: params.get("image") ?? undefined,
    } as unknown as Spec;
    run(spec).then((result) => say(typeof result === "string" ? "done" : JSON.stringify(result, null, 2)), (err) => say(String(err)));
  }
}
