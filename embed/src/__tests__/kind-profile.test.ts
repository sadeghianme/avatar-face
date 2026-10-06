import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { ClassicMouth } from "../engine/paint-classic-mouth";
import { HUMAN_PROFILE, kindProfile } from "../kind-profile";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../types";

/**
 * Render profiles: a rig that names "animal@1" gets the muzzle's mouth
 * interior, every other rig gets exactly today's. The goldens pin the
 * "exactly"; these pin what the profile does and that nothing else selects it.
 */

const loadRig = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Rig;
const human = loadRig("human-rig.json");

/** A 2D context that logs what is drawn and hands back gradients. */
function recordingCanvas(log: string[]) {
  const target: Record<string, unknown> = {
    createLinearGradient: (...a: number[]) => {
      log.push(`linear(${a.map((v) => v.toFixed(2)).join(",")})`);
      return { addColorStop: (o: number, c: string) => log.push(`stop(${o},${c})`) };
    },
    createRadialGradient: (...a: number[]) => {
      log.push(`radial(${a.map((v) => v.toFixed(2)).join(",")})`);
      return { addColorStop: (o: number, c: string) => log.push(`stop(${o},${c})`) };
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      for (let i = 0; i < data.length; i += 4) data.set([182, 128, 110, 255], i);
      return { data, width: w, height: h };
    },
    measureText: () => ({ width: 0 }),
  };
  const ctx = new Proxy(target, {
    get(obj, key: string) {
      if (key in obj) return obj[key];
      return (...args: unknown[]) => {
        log.push(`${key}(${args.map((a) => (typeof a === "number" ? a.toFixed(2) : typeof a)).join(",")})`);
      };
    },
    set(obj, key: string, value: unknown) {
      obj[key] = value;
      log.push(`${key}=${typeof value === "object" ? "grad" : String(value)}`);
      return true;
    },
  });
  return { width: 512, height: 512, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

class NoopPath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  ellipse() {}
  rect() {}
  closePath() {}
  addPath() {}
}

type Internals = {
  face: { weights: BlendWeights };
  render(): void;
};

/** The classic mouth's parts, to count which ran. */
type ClassicMouthParts = {
  drawTeethRow(...args: unknown[]): void;
  drawLipContactLine(...args: unknown[]): void;
};

/** One frame of `rig` in `weights`: the draw log, and which mouth parts ran. */
function frame(rig: Rig, weights: Partial<BlendWeights>) {
  const log: string[] = [];
  vi.stubGlobal("document", { createElement: () => recordingCanvas([]) });
  const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
  const proto = ClassicMouth.prototype as unknown as ClassicMouthParts;
  const teeth = vi.spyOn(proto, "drawTeethRow");
  const contact = vi.spyOn(proto, "drawLipContactLine");
  const engine = new AvatarEngine(recordingCanvas(log), rig, image, { fullPhoto: true });
  log.length = 0;
  const e = engine as unknown as Internals;
  e.face.weights = { ...ZERO_WEIGHTS, ...weights };
  e.render();
  engine.destroy();
  const result = { log: log.join("\n"), teeth: teeth.mock.calls.length, contact: contact.mock.calls.length };
  teeth.mockRestore();
  contact.mockRestore();
  return result;
}

const withProfile = (rig: Rig, render_profile: string | null | undefined): Rig => ({ ...rig, render_profile });

describe("render profiles", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("only the rig selects one; absent or unknown is today's renderer", () => {
    expect(kindProfile(human)).toBe(HUMAN_PROFILE);
    expect(kindProfile({ render_profile: null })).toBe(HUMAN_PROFILE);
    expect(kindProfile({ render_profile: "animal@99" })).toBe(HUMAN_PROFILE);
    expect(kindProfile({ render_profile: "toString" })).toBe(HUMAN_PROFILE);
    expect(kindProfile({ render_profile: "animal@1" }).teeth).toBe(false);
  });

  it("an animal@1 rig with an open mouth never draws incisors; the same rig without it does", () => {
    const open = human.visemes.aa;
    expect(frame(human, open).teeth).toBeGreaterThan(0);
    expect(frame(withProfile(human, "animal@1"), open).teeth).toBe(0);
    // Nor on the shapes that show teeth through retraction rather than gape.
    for (const shape of ["E", "SS", "FF"]) {
      expect(frame(withProfile(human, "animal@1"), human.visemes[shape]).teeth).toBe(0);
    }
  });

  it("an animal@1 rig has no lip contact line", () => {
    expect(frame(human, {}).contact).toBe(1);
    expect(frame(withProfile(human, "animal@1"), {}).contact).toBe(0);
  });

  it("an animal@1 cavity is darker and shows a tongue sooner", () => {
    const shape = human.visemes.E; // open, but short of the human tongue
    const people = frame(human, shape).log;
    const muzzle = frame(withProfile(human, "animal@1"), shape).log;
    const firstStop = (log: string) => log.match(/stop\(0,rgb\((\d+), (\d+), (\d+)\)\)/)!.slice(1).map(Number);
    const [hr] = firstStop(people);
    const [ar] = firstStop(muzzle);
    expect(ar).toBeLessThan(hr);
    const tongues = (log: string) => (log.match(/^radial\(/gm) ?? []).length;
    expect(tongues(muzzle)).toBe(tongues(people) + 1);
  });

  it("an unknown or empty profile draws exactly what no profile draws", () => {
    const open = human.visemes.aa;
    const plain = frame(human, open).log;
    expect(frame(withProfile(human, "animal@99"), open).log).toBe(plain);
    expect(frame(withProfile(human, null), open).log).toBe(plain);
    expect(frame(withProfile(human, ""), open).log).toBe(plain);
  });
});

/**
 * A rig fitted from a mouth line (backend anchor_fit, the "toon big grin"
 * layout on the face template) has each corner's four commissure landmarks
 * on one point, and a triangle list can draw only one of them. The engine
 * moves the inner corners (78, 308) on closed-mouth shapes and not the
 * outer ones, so the fit must draw the same kind of landmark at both
 * corners, or one corner of the mouth moves and the other stays.
 */
describe("a rig fitted from a mouth line", () => {
  const fitted = loadRig("fitted-animal-rig.json");
  const LEFT = [61, 76, 62, 78];
  const RIGHT = [291, 306, 292, 308];
  const drawn = new Set(fitted.triangles.flat());
  const drawnOf = (corner: number[]) => corner.filter((i) => drawn.has(i));

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => recordingCanvas([]) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws the inner corner at both ends", () => {
    expect(drawnOf(LEFT)).toEqual([78]);
    expect(drawnOf(RIGHT)).toEqual([308]);
  });

  it("moves both corners alike on closed-mouth shapes", () => {
    const image = { naturalWidth: 1000, naturalHeight: 1000, width: 1000, height: 1000 } as HTMLImageElement;
    const engine = new AvatarEngine(recordingCanvas([]), fitted, image, { fullPhoto: true });
    const e = engine as unknown as Internals & { deformedPoints(now: number): { x: number; y: number }[] };
    const pose = (weights: Partial<BlendWeights>) => {
      e.face.weights = { ...ZERO_WEIGHTS, ...weights };
      return e.deformedPoints(10_000);
    };
    const rest = pose({});
    for (const shape of ["PP", "FF"]) {
      const moved = pose(fitted.visemes[shape]);
      const shift = (i: number) => ({ dx: moved[i].x - rest[i].x, dy: moved[i].y - rest[i].y });
      // The corners as drawn, whichever landmarks the triangles use.
      const [left, right] = [shift(drawnOf(LEFT)[0]), shift(drawnOf(RIGHT)[0])];
      expect(Math.abs(left.dy), shape).toBeGreaterThan(1);
      expect(Math.abs(left.dy - right.dy), shape).toBeLessThan(0.5);
      expect(Math.abs(left.dx + right.dx), shape).toBeLessThan(0.5);
    }
    engine.destroy();
  });
});
