import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../types";

/**
 * Golden output of the character mouth ("toon@1", "animal@2"), in the same
 * terms as golden-render.test.ts: the deformed mesh and every drawing call of
 * one frame, as digests, with the numbers that say what a failure means.
 *
 * The existing goldens pin what every avatar already live renders; these pin
 * the NEW profiles, in their own snapshot file, so changing the character
 * mouth never touches the other. A rig that does not name one of these
 * profiles must never reach this code at all (character-mouth.test.ts).
 *
 * Two textures: one flat colour (cel art, which is what the look sampler calls
 * flat), and one that changes with position (a render, which gets shading).
 */

const rig = JSON.parse(
  readFileSync(new URL("./fixtures/fitted-animal-rig.json", import.meta.url), "utf8")
) as Rig;

const round = (v: number) => Math.round(v * 100) / 100;

class RecordingPath {
  ops: string[] = [];
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
  addPath() {}
}

type Texture = (x: number, y: number) => [number, number, number, number];
const flatSkin: Texture = () => [182, 128, 110, 255];
const positional: Texture = (x, y) => [(x * 3 + y) % 256, (x + y * 5) % 256, (x * 7 + y * 11) % 256, 255];

const describeArg = (a: unknown) =>
  typeof a === "number" ? round(a) : a instanceof RecordingPath ? `path[${a.ops.join(" ")}]` : typeof a === "object" && a ? "img" : String(a);

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
      return (...args: unknown[]) => { log.push(`${key}(${args.map(describeArg).join(",")})`); };
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

const fakeCanvas = (log: string[], texture: Texture, size = 512) =>
  ({ width: size, height: size, getContext: () => recordingContext(log, texture) }) as unknown as HTMLCanvasElement;

let seed = 1;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function frame(profile: string, texture: Texture, weights: Partial<BlendWeights>, extra: { blink?: number; tongue?: number } = {}) {
  const log: string[] = [];
  vi.stubGlobal("document", { createElement: () => fakeCanvas([], texture, 64) });
  const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
  const engine = new AvatarEngine(fakeCanvas(log, texture), { ...rig, render_profile: profile }, image, { fullPhoto: false });
  log.length = 0;
  const e = engineSeam(engine);
  const rest = e.deformedPoints();
  e.face.weights = { ...ZERO_WEIGHTS, ...weights };
  e.face.blink = extra.blink ?? 0;
  e.face.gaze = { x: 0, y: 0 };
  e.face.tongue = extra.tongue ?? 0;
  const pts = e.deformedPoints();
  e.render();
  engine.destroy();
  const digest = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
  return {
    lipGapPx: round(pts[14].y - pts[13].y),
    chinDropPx: round(pts[152].y - rest[152].y),
    mesh: digest(pts.map((p) => `${round(p.x)},${round(p.y)}`).join(";")),
    drawCalls: log.length,
    drawing: digest(log.join("\n")),
  };
}

const cases: [string, Partial<BlendWeights>, { blink?: number; tongue?: number }][] = [
  ["rest", {}, {}],
  ["aa (open)", rig.visemes.aa, {}],
  ["oh (rounded)", rig.visemes.oh, {}],
  ["E (spread)", rig.visemes.E, {}],
  ["FF", rig.visemes.FF, {}],
  ["TH, tongue up", rig.visemes.TH, { tongue: 1 }],
  ["blink full", {}, { blink: 0.35 }],
];

describe.each(["toon@1", "animal@2"])("%s golden output", (profile) => {
  beforeEach(() => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", RecordingPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  for (const [label, texture] of [["flat art", flatSkin], ["render", positional]] as const) {
    for (const [name, weights, extra] of cases) {
      it(`${label}, ${name}: mesh and drawing are unchanged`, () => {
        const out = frame(profile, texture, weights, extra);
        expect(out).toMatchSnapshot();
      });
    }
  }
});

describe("the character mouth is only for its profiles", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", RecordingPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const logOf = (profile: string | null, weights: Partial<BlendWeights>) => {
    const log: string[] = [];
    vi.stubGlobal("document", { createElement: () => fakeCanvas([], flatSkin, 64) });
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
    const r = { ...rig } as Rig;
    if (profile) r.render_profile = profile;
    else delete r.render_profile;
    const engine = new AvatarEngine(fakeCanvas(log, flatSkin), r, image, { fullPhoto: false });
    log.length = 0;
    const e = engineSeam(engine);
    e.face.weights = { ...ZERO_WEIGHTS, ...weights };
    e.render();
    engine.destroy();
    return log.join("\n");
  };

  it("paints a tongue in a toon@1 mouth that the classic mouth of the same rig does not", () => {
    const aa = rig.visemes.aa;
    // The classic mouth draws its tongue as a radial gradient; the character
    // mouth fills a flat tongue colour on cel art.
    expect(logOf("toon@1", aa)).not.toBe(logOf(null, aa));
    expect(logOf("animal@1", aa)).not.toBe(logOf("animal@2", aa));
  });

  it("leaves a rig with no profile, or an unknown one, exactly as it was", () => {
    const aa = rig.visemes.aa;
    expect(logOf("toon@9", aa)).toBe(logOf(null, aa));
  });
});
