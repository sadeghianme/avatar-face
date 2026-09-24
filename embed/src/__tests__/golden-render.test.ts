import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../types";

/**
 * Golden output of the renderer, for every kind of rig already live.
 *
 * The three avatar lines (human, animal, animation) move today's anatomical
 * constants into per-line profiles. Existing avatars must not change by a
 * single pixel when that happens, and nobody can see a sub-pixel drift by
 * eye. So this pins, for a fixed set of mouth, blink and gaze states:
 *   - the deformed mesh (every vertex, rounded to 1/100 px), and
 *   - every drawing call one frame makes (method, rounded numbers, styles).
 * A digest per state keeps the snapshot readable; the aperture numbers next
 * to it say what a failure means in plain terms.
 *
 * Pinned: a detected human rig in both framings (the whole photo, and the
 * default crop to the face), a legacy animal rig (synthetic mesh, muzzle
 * visemes, hand marks — built exactly as production built one before the
 * anchor fit, by backend/scripts/build_legacy_animal_rig.py, retired with
 * that fit: the fixture is frozen, since it stands for rigs already live),
 * and a texture whose colour changes with position, so sampling colour at
 * the wrong pixel changes the output.
 *
 * If a change is SUPPOSED to alter rendering, update the snapshot in the
 * same commit and say why in its message.
 */

const loadRig = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Rig;
const rig = loadRig("human-rig.json");
const animalRig = loadRig("legacy-animal-rig.json");

const round = (v: number) => Math.round(v * 100) / 100;

/** Path2D is not in Node; this one remembers its commands so fills of a
 *  path are pinned by shape, not just by the fact that something was filled. */
class RecordingPath {
  ops: string[] = [];
  constructor(from?: RecordingPath) {
    if (from) this.ops.push(...from.ops);
  }
  private add(op: string, args: number[]) {
    this.ops.push(`${op}(${args.map(round).join(",")})`);
  }
  moveTo(...a: number[]) { this.add("M", a); }
  lineTo(...a: number[]) { this.add("L", a); }
  quadraticCurveTo(...a: number[]) { this.add("Q", a); }
  bezierCurveTo(...a: number[]) { this.add("C", a); }
  arc(...a: number[]) { this.add("A", a); }
  ellipse(...a: number[]) { this.add("E", a); }
  rect(...a: number[]) { this.add("R", a); }
  closePath() { this.ops.push("Z"); }
  addPath(other: RecordingPath) { this.ops.push(...other.ops); }
}

const describeArg = (a: unknown) =>
  typeof a === "number"
    ? round(a)
    : a instanceof RecordingPath
      ? `path[${a.ops.join(" ")}]`
      : typeof a === "object" && a
        ? "img"
        : String(a);

type Pixel = [number, number, number, number];
/** The colour a texture has at (x, y), in texture pixels. */
type Texture = (x: number, y: number) => Pixel;

const flatSkin: Texture = () => [182, 128, 110, 255];
/** Every channel a different function of position, none of them symmetric,
 *  so no two nearby sample points read the same colour by accident. */
const positional: Texture = (x, y) => [
  (x * 3 + y) % 256,
  (x + y * 5) % 256,
  (x * 7 + y * 11) % 256,
  255,
];

/** A 2D context that records what is drawn instead of drawing it. */
function recordingContext(log: string[], texture: Texture) {
  const gradient = (kind: string) => (...args: number[]) => {
    log.push(`${kind}(${args.map(round).join(",")})`);
    return { addColorStop: (o: number, c: string) => log.push(`stop(${round(o)},${c})`) };
  };
  const target: Record<string, unknown> = {
    createLinearGradient: gradient("linear"),
    createRadialGradient: gradient("radial"),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      for (let i = 0; i < data.length; i += 4) {
        const n = i / 4;
        data.set(texture(x + (n % w), y + Math.floor(n / w)), i);
      }
      return { data, width: w, height: h };
    },
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(target, {
    get(obj, key: string) {
      if (key in obj) return obj[key];
      return (...args: unknown[]) => {
        log.push(`${key}(${args.map(describeArg).join(",")})`);
      };
    },
    set(obj, key: string, value: unknown) {
      obj[key] = value;
      if (key !== "imageSmoothingEnabled" && key !== "imageSmoothingQuality") {
        log.push(`${key}=${typeof value === "number" ? round(value) : typeof value === "object" ? "grad" : String(value)}`);
      }
      return true;
    },
  });
}

function fakeCanvas(log: string[], texture: Texture, size = 512) {
  const ctx = recordingContext(log, texture);
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

// Deterministic randomness and time: every engine subsystem that wanders
// (saccades, sway, blinks) reads these two.
let seed = 1;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

interface Probe {
  engine: AvatarEngine;
  log: string[];
}

function makeEngine(
  source: Rig = rig,
  { fullPhoto = true, texture = flatSkin }: { fullPhoto?: boolean; texture?: Texture } = {}
): Probe {
  const log: string[] = [];
  const scratch: string[] = [];
  vi.stubGlobal("document", {
    createElement: () => fakeCanvas(scratch, texture, 64),
  });
  const canvas = fakeCanvas(log, texture);
  const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
  const engine = new AvatarEngine(canvas, source, image, { fullPhoto });
  log.length = 0;
  return { engine, log };
}

type EngineInternals = {
  weights: BlendWeights;
  blink: number;
  gaze: { x: number; y: number };
  deformedPoints(now: number): { x: number; y: number }[];
  render(): void;
};

function state(engine: AvatarEngine, weights: Partial<BlendWeights>, blink = 0, gaze = { x: 0, y: 0 }) {
  const e = engine as unknown as EngineInternals;
  e.weights = { ...ZERO_WEIGHTS, ...weights };
  e.blink = blink;
  e.gaze = { ...gaze };
  return e;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const LOWER_INNER = 14;
const UPPER_INNER = 13;
const LEFT_UPPER_LID = 159;
const LEFT_LOWER_LID = 145;

type Case = { name: string; weights: Partial<BlendWeights>; blink?: number; gaze?: { x: number; y: number } };

/** The same states for any rig, driven by that rig's own viseme table. */
const casesFor = (source: Rig): Case[] => [
  { name: "rest", weights: {} },
  { name: "aa (open)", weights: source.visemes.aa },
  { name: "oh (rounded)", weights: source.visemes.oh },
  { name: "PP (closed)", weights: source.visemes.PP },
  { name: "E (spread)", weights: source.visemes.E },
  { name: "FF", weights: source.visemes.FF },
  { name: "smile", weights: { mouthSmile: 0.6 } },
  { name: "blink half", weights: {}, blink: 0.5 },
  { name: "blink full", weights: {}, blink: 1 },
  { name: "gaze right-up", weights: {}, gaze: { x: 0.25, y: -0.1 } },
];

/** One frame of `probe` in state `c`, reduced to what the snapshot pins. */
function frame({ engine, log }: Probe, c: Case) {
  const e = state(engine, c.weights, c.blink ?? 0, c.gaze);
  const pts = e.deformedPoints(10_000);
  const mesh = pts.map((p) => `${round(p.x)},${round(p.y)}`).join(";");
  e.render();
  engine.destroy();
  return {
    vertices: pts.length,
    lipGapPx: round(pts[LOWER_INNER].y - pts[UPPER_INNER].y),
    leftEyeOpenPx: round(pts[LEFT_LOWER_LID].y - pts[LEFT_UPPER_LID].y),
    mesh: digest(mesh),
    drawCalls: log.length,
    drawing: digest(log.join("\n")),
  };
}

function deterministic() {
  beforeEach(() => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("Path2D", RecordingPath);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

describe("human renderer golden output", () => {
  deterministic();
  for (const c of casesFor(rig)) {
    it(`${c.name}: mesh and drawing are unchanged`, () => {
      expect(frame(makeEngine(), c)).toMatchSnapshot();
    });
  }
});

describe("human renderer golden output, face framing", () => {
  // The default: what every embed without data-framing="full" draws.
  deterministic();
  for (const c of casesFor(rig)) {
    it(`${c.name}: mesh and drawing are unchanged`, () => {
      expect(frame(makeEngine(rig, { fullPhoto: false }), c)).toMatchSnapshot();
    });
  }
});

describe("legacy animal rig golden output", () => {
  deterministic();
  for (const fullPhoto of [false, true]) {
    for (const c of casesFor(animalRig)) {
      it(`${fullPhoto ? "full photo" : "face"}, ${c.name}: mesh and drawing are unchanged`, () => {
        expect(frame(makeEngine(animalRig, { fullPhoto }), c)).toMatchSnapshot();
      });
    }
  }
});

describe("colour sampled from a position-dependent texture", () => {
  deterministic();
  const sampled = casesFor(rig).filter((c) => ["rest", "aa (open)", "blink full"].includes(c.name));
  for (const [label, source] of [["human", rig], ["legacy animal", animalRig]] as const) {
    for (const c of sampled) {
      it(`${label}, ${c.name}: mesh and drawing are unchanged`, () => {
        expect(frame(makeEngine(source, { fullPhoto: false, texture: positional }), c)).toMatchSnapshot();
      });
    }
  }

  it("the texture's colours reach the drawing", () => {
    // Without this the positional cases could pass while pinning nothing
    // about sampling: a flat and a varied texture must draw an open mouth
    // differently, because its interior is painted from the sampled lips.
    const open = casesFor(rig).find((c) => c.name === "aa (open)")!;
    const flat = frame(makeEngine(rig, { fullPhoto: false }), open);
    seed = 1;
    const varied = frame(makeEngine(rig, { fullPhoto: false, texture: positional }), open);
    expect(varied.mesh).toBe(flat.mesh);
    expect(varied.drawing).not.toBe(flat.drawing);
  });
});
