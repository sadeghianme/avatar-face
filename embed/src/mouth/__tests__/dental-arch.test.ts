import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import type { MouthPoint, MouthTurn } from "../../mouth-extension";
import {
  ARCH_MM,
  ARCH_STRIPS,
  TurnedArch,
  archDepthMm,
  drawTurnedArch,
  mouthAxis,
  turnedLocal,
  type Rect,
} from "../dental-arch";

/**
 * The dental arches in depth (dental-arch.ts): how deep each column of an
 * arch lies, the turn split into a frame and a bend in strips, the bands
 * the strips are cut at, and the drawing: exactly the frontal one at no
 * turn, continuous from there, with no seam between the strips.
 */

/** A turn seen orthographically: a point `depth` behind the lips moves by
 *  depth * sin(yaw) less, sideways, and by depth * sin(pitch) less, down. */
const turnOf = (yawDeg: number, pitchDeg = 0, mm = 4): MouthTurn => {
  const yaw = (yawDeg * Math.PI) / 180,
    pitch = (pitchDeg * Math.PI) / 180;
  return {
    yaw,
    pitch,
    mm,
    behindLips(out: MouthPoint, x: number, y: number, depth: number) {
      out.x = x - depth * Math.sin(yaw);
      out.y = y - depth * Math.sin(pitch);
      return out;
    },
  };
};
/** A mouth 200 px wide (50 mm at turnOf's 4 px per mm), level, at (480, 500). */
const axis = mouthAxis({ x: 380, y: 500 }, { x: 580, y: 500 });
/** An upper arch: its picture's width (the teeth photo's 640), the box of
 *  it the teeth are in, and the rectangle of the mouth's local units it is
 *  drawn on facing the camera (dentalPlacement's). */
const WIDTH = 640;
const box: Rect = { x: 96, y: 60, width: 448, height: 88 };
const rect: Rect = { x: -0.4375, y: -0.122, width: 0.875, height: 0.172 };
const laid = (turn: MouthTurn, lower = false) => new TurnedArch().lay(WIDTH, box, rect, axis, lower, turn);
const strip = (arch: TurnedArch, k: number) => Array.from(arch.strips.subarray(6 * k, 6 * k + 6));
/** Where the arch puts the picture's (u, v) of strip `k`, local units: the
 *  bend, the picture to the rectangle, the frame. */
const seenAt = (arch: TurnedArch, k: number, u: number, v: number) => {
  const [a, b, c, d, e, f] = strip(arch, k);
  const bu = a * u + c * v + e,
    bv = b * u + d * v + f;
  const x = rect.x + ((bu - box.x) * rect.width) / box.width,
    y = rect.y + ((bv - box.y) * rect.height) / box.height;
  const F = arch.frame;
  return { x: F.a * x + F.c * y + F.e, y: F.b * x + F.d * y + F.f };
};
/** The picture's column at strip edge `k` (fractional `k` for inside one). */
const columnAt = (k: number) => box.x + (box.width * k) / ARCH_STRIPS;
const localAt = (k: number) => rect.x + (rect.width * k) / ARCH_STRIPS;

describe("the arches' depth", () => {
  it("is the incisors' behind the lips at the midline, the lower behind the upper", () => {
    expect(archDepthMm(false, 0)).toBe(ARCH_MM.upper);
    expect(archDepthMm(true, 0)).toBe(ARCH_MM.lower);
    expect(ARCH_MM.lower).toBeGreaterThan(ARCH_MM.upper);
  });

  it("curves back toward the molars, alike either side", () => {
    // The canines, 17 mm out, about 9 mm further back; the first molars, 25 mm out, about 19.
    expect(archDepthMm(false, 17) - ARCH_MM.upper).toBeCloseTo(9, 0);
    expect(archDepthMm(false, 25) - ARCH_MM.upper).toBeCloseTo(19.4, 1);
    expect(archDepthMm(true, -17)).toBe(archDepthMm(true, 17));
  });
});

describe("the mouth's axis", () => {
  it("is the anchors' centre, width and direction, and round-trips local units", () => {
    const tilted = mouthAxis({ x: 100, y: 100 }, { x: 180, y: 160 });
    expect(tilted).toMatchObject({ cx: 140, cy: 130, width: 100 });
    expect(tilted.cos).toBeCloseTo(0.8, 12);
    expect(tilted.sin).toBeCloseTo(0.6, 12);
    const p = turnedLocal(tilted, turnOf(0), 0.3, -0.2, 10, { x: 0, y: 0 });
    expect(p.x).toBeCloseTo(0.3, 12);
    expect(p.y).toBeCloseTo(-0.2, 12);
  });
});

describe("an arch turned", () => {
  it("is the identity, frame and strips, cut at its columns, facing the camera", () => {
    const arch = laid(turnOf(0));
    const { a, b, c, d, e, f } = arch.frame;
    [a - 1, b, c, d - 1, e, f].forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-12));
    for (let k = 0; k < ARCH_STRIPS; k++) {
      const got = strip(arch, k);
      [1, 0, 0, 1, 0, 0].forEach((want, i) => expect(Math.abs(got[i] - want)).toBeLessThan(1e-9));
      if (k) expect(arch.edges[k]).toBe(Math.round(columnAt(k)));
    }
    expect(arch.edges[0]).toBe(0);
    expect(arch.edges[ARCH_STRIPS]).toBe(WIDTH);
  });

  it("is where the turn shows each column, frame and bend together", () => {
    const turn = turnOf(9, 5);
    const arch = laid(turn, true);
    const want = { x: 0, y: 0 };
    for (let k = 0; k <= ARCH_STRIPS; k++) {
      const x = localAt(k);
      for (const [v, y] of [
        [box.y, rect.y],
        [box.y + box.height, rect.y + rect.height],
      ]) {
        turnedLocal(axis, turn, x, y, archDepthMm(true, (x * axis.width) / turn.mm), want);
        const got = seenAt(arch, Math.min(k, ARCH_STRIPS - 1), columnAt(k), v);
        expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(1e-9);
      }
    }
  });

  it("frames the box the turned arch spans: lagging the lips, a hair larger", () => {
    const yaw = 9;
    const { frame } = laid(turnOf(yaw, 3));
    // The incisors 10 mm behind the lips (4 px per mm, 200 px wide) lag
    // them; the molars, deeper, lag more, so the span starts further left.
    const lag = (ARCH_MM.upper * 4 * Math.sin((yaw * Math.PI) / 180)) / axis.width;
    expect(frame.a * rect.x + frame.e).toBeLessThan(rect.x - lag);
    expect(frame.b).toBe(0);
    expect(frame.c).toBe(0);
    expect(frame.a).toBeGreaterThan(0.95);
    expect(frame.a).toBeLessThan(1.05);
    expect(frame.d).toBeGreaterThan(1);
    expect(frame.d).toBeLessThan(1.5);
  });

  it("keeps the arch inside its box, near enough: the bend moves its corners by under a pixel", () => {
    // At the personality's limits, 9 degrees of yaw and 5 of pitch.
    for (const turn of [turnOf(9, 5), turnOf(-9, -5)])
      for (const lower of [false, true]) {
        const arch = laid(turn, lower);
        let out = 0;
        for (const [k, u] of [
          [0, box.x],
          [ARCH_STRIPS - 1, box.x + box.width],
        ])
          for (const v of [box.y, box.y + box.height]) {
            const [a, b, c, d, e, f] = strip(arch, k);
            const x = a * u + c * v + e,
              y = b * u + d * v + f;
            out = Math.max(out, box.x - x, x - box.x - box.width, box.y - y, y - box.y - box.height);
          }
        expect(out).toBeLessThan(1);
      }
  });

  it("is continuous across its strips: neighbours meet on their shared edge", () => {
    const arch = laid(turnOf(9, 5), true);
    for (let k = 0; k < ARCH_STRIPS - 1; k++) {
      for (const v of [box.y, box.y + box.height / 2, box.y + box.height]) {
        const p = seenAt(arch, k, columnAt(k + 1), v),
          q = seenAt(arch, k + 1, columnAt(k + 1), v);
        expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(1e-9);
      }
    }
  });

  it("lags the lips by its depth, and widens on the side coming toward the camera", () => {
    const yaw = 9;
    const arch = laid(turnOf(yaw));
    // The midline: the incisors 10 mm behind the lips, 4 px per mm, on a
    // mouth 200 px wide.
    const lag = (ARCH_MM.upper * 4 * Math.sin((yaw * Math.PI) / 180)) / axis.width;
    expect(seenAt(arch, ARCH_STRIPS / 2, columnAt(ARCH_STRIPS / 2), box.y).x).toBeCloseTo(-lag, 9);
    // yaw + turns the nose to the canvas's right: the arch's left half
    // (toward -x) widens, its right half foreshortens, by the curve.
    const along = (k: number) => seenAt(arch, k, columnAt(k + 1), box.y).x - seenAt(arch, k, columnAt(k), box.y).x;
    const frontal = rect.width / ARCH_STRIPS;
    expect(along(0) / frontal).toBeGreaterThan(1.01);
    expect(along(ARCH_STRIPS - 1) / frontal).toBeLessThan(0.99);
  });

  it("strays from the arch's curve by under 0.05 px of the mouth between its strip edges", () => {
    // At the personality's 9 degrees on this mouth (4 px per mm).
    const turn = turnOf(9);
    const arch = laid(turn);
    let worst = 0;
    const exact = { x: 0, y: 0 };
    for (let k = 0; k < ARCH_STRIPS; k++) {
      const x = localAt(k + 0.5);
      turnedLocal(axis, turn, x, rect.y, archDepthMm(false, (x * axis.width) / turn.mm), exact);
      const got = seenAt(arch, k, columnAt(k + 0.5), box.y);
      worst = Math.max(worst, Math.abs(got.x - exact.x) * axis.width);
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.05);
  });

  it("is cut in bands of whole pixels that never run backwards", () => {
    for (const turn of [turnOf(9, 5), turnOf(-9, -5)]) {
      const { edges } = laid(turn);
      for (let k = 1; k <= ARCH_STRIPS; k++) {
        expect(Number.isInteger(edges[k])).toBe(true);
        expect(edges[k]).toBeGreaterThan(edges[k - 1]);
      }
    }
    // A turn that would fold the arch back on itself near its ends (no
    // head does): the bands there close up rather than run backwards.
    const folding: MouthTurn = {
      ...turnOf(0),
      behindLips: (out, x, y) => {
        const t = (x - axis.cx) / axis.width;
        out.x = axis.cx + axis.width * (t - 12 * t * t * t);
        out.y = y;
        return out;
      },
    };
    const { edges } = laid(folding);
    for (let k = 1; k <= ARCH_STRIPS; k++) expect(edges[k]).toBeGreaterThanOrEqual(edges[k - 1]);
    expect(edges[2]).toBe(edges[1]);
  });
});

describe("an arch drawn turned", () => {
  /** A picture like an arch's: transparent, the teeth in `box`, a band of
   *  enamel-ish crowns with soft edges. */
  const picture = (() => {
    const c = createCanvas(WIDTH, 480);
    const g = c.getContext("2d");
    for (let x = box.x; x < box.x + box.width; x += 16) {
      g.fillStyle = `rgba(${230 - (x % 48)}, ${220 - (x % 32)}, 200, ${0.6 + (x % 64) / 160})`;
      g.beginPath();
      g.ellipse(x + 8, box.y + box.height / 2, 7.5, box.height / 2, 0, 0, Math.PI * 2);
      g.fill();
    }
    return c as unknown as HTMLCanvasElement;
  })();
  /** A face's canvas, the mouth's frame on it as dental-oral-surface.ts
   *  lays it (300 px wide, tilted 4 degrees), the teeth's opening clipped,
   *  their reveal and their light set. */
  const tilt = (4 * Math.PI) / 180;
  const mouth = mouthAxis(
    { x: 200 - 150 * Math.cos(tilt), y: 100 - 150 * Math.sin(tilt) },
    { x: 200 + 150 * Math.cos(tilt), y: 100 + 150 * Math.sin(tilt) }
  );
  const face = () => {
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = "#3a2420";
    ctx.fillRect(0, 0, 400, 200);
    ctx.translate(200, 100);
    ctx.rotate(tilt);
    ctx.scale(300, 300);
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.42, 0.13, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = 0.85;
    ctx.filter = "brightness(1.08) sepia(0.06)";
    return ctx;
  };
  const pixels = (ctx: CanvasRenderingContext2D) => ctx.getImageData(0, 0, 400, 200).data;
  const frontal = () => {
    const ctx = face();
    ctx.drawImage(picture, box.x, box.y, box.width, box.height, rect.x, rect.y, rect.width, rect.height);
    return pixels(ctx);
  };
  /** Turned by yaw and pitch, degrees: 300 px for a 50 mm mouth. */
  const turnedBy = (yawDeg: number, pitchDeg = 0) => {
    const ctx = face();
    const arch = new TurnedArch().lay(WIDTH, box, rect, mouth, false, turnOf(yawDeg, pitchDeg, 6));
    drawTurnedArch(ctx, arch, picture, box, rect, createCanvas(1, 1) as unknown as HTMLCanvasElement);
    return pixels(ctx);
  };
  /** The frontal arch moved by the frame the turn gives it, no bend. */
  const framedBy = (yawDeg: number, pitchDeg = 0) => {
    const ctx = face();
    const { a, b, c, d, e, f } = new TurnedArch().lay(
      WIDTH,
      box,
      rect,
      mouth,
      false,
      turnOf(yawDeg, pitchDeg, 6)
    ).frame;
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(picture, box.x, box.y, box.width, box.height, rect.x, rect.y, rect.width, rect.height);
    return pixels(ctx);
  };
  /** The largest and the mean difference of two frames' channels, levels. */
  const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let max = 0,
      sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      max = Math.max(max, d);
      sum += d;
    }
    return { max, mean: sum / a.length };
  };

  it("is exactly the arch drawn facing the camera when nothing turned it", () => {
    expect(Buffer.from(turnedBy(0)).equals(Buffer.from(frontal()))).toBe(true);
  });

  it("moves from the frontal drawing continuously as the turn grows from nothing", () => {
    // Yaw, and half as much pitch, from a hundred-thousandth of a degree
    // to the personality's limit.
    const degrees = [1e-5, 1e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1];
    const want = frontal();
    const turned = degrees.map((deg) => difference(turnedBy(deg, deg / 2), want));
    // On average, from nothing, with the turn: no step anywhere.
    expect(turned[0].mean).toBeLessThan(0.001);
    for (let i = 1; i < degrees.length; i++) {
      expect(turned[i].mean).toBeGreaterThan(turned[i - 1].mean);
      expect(turned[i].mean).toBeLessThan(turned[i - 1].mean * 12);
    }
    // Pixel for pixel, within a level or two of rounding to a thousandth
    // of a degree. Past that Skia's raster moves an image's antialiased
    // edge in steps (a frontal arch moved 0.003 px moves an edge pixel by
    // 23 levels), so the turned drawing is held to the frontal one moved
    // as the turn moves it (the frame): what the bend adds starts from
    // nothing and grows with the turn.
    for (let i = 0; i <= 2; i++) expect(turned[i].max).toBeLessThanOrEqual(2);
    const bend = degrees.map((deg) => difference(turnedBy(deg, deg / 2), framedBy(deg, deg / 2)));
    expect(bend[0].max).toBe(0);
    expect(bend[2].max).toBeLessThanOrEqual(1);
    expect(bend[4].max).toBeLessThanOrEqual(6);
    for (let i = 1; i < degrees.length; i++) {
      expect(bend[i].max).toBeGreaterThanOrEqual(bend[i - 1].max);
      expect(bend[i].mean).toBeGreaterThanOrEqual(bend[i - 1].mean);
    }
  });

  it("leaves no seam between its strips", () => {
    const solid = createCanvas(WIDTH, 480);
    const g = solid.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(box.x, box.y, box.width, box.height);
    const bent = createCanvas(1, 1);
    const arch = new TurnedArch().lay(WIDTH, box, rect, mouth, false, turnOf(9, 4, 6));
    const ctx = createCanvas(400, 200).getContext("2d") as unknown as CanvasRenderingContext2D;
    drawTurnedArch(ctx, arch, solid as unknown as HTMLCanvasElement, box, rect, bent as unknown as HTMLCanvasElement);
    // The bent picture: down every band edge, and the column before it,
    // every pixel two or more inside the arch's top and bottom is whole.
    const data = bent.getContext("2d").getImageData(0, 0, WIDTH, 480).data;
    const alpha = (x: number, y: number) => data[(y * WIDTH + x) * 4 + 3];
    let checked = 0;
    for (let k = 1; k < ARCH_STRIPS; k++) {
      for (const x of [arch.edges[k] - 1, arch.edges[k]]) {
        const inside = Array.from({ length: 480 }, (_, y) => y).filter((y) => alpha(x, y) > 0);
        const top = Math.min(...inside),
          bottom = Math.max(...inside);
        expect(bottom - top).toBeGreaterThan(70);
        for (let y = top + 2; y <= bottom - 2; y++) expect(alpha(x, y)).toBe(255);
        checked++;
      }
    }
    expect(checked).toBe(2 * (ARCH_STRIPS - 1));
  });

  it("is moved by the turn: the arch lags the lips", () => {
    // The teeth's columns along the mouth's middle, frontal and turned: the
    // turned ones about 10 mm * sin(9 deg) * 6 px per mm (9 px) to the left.
    const profile = (data: Uint8ClampedArray) =>
      Array.from({ length: 400 }, (_, x) => data[(100 * 400 + x) * 4]).slice(120, 280);
    const still = profile(frontal()),
      moved = profile(turnedBy(9));
    const mismatch = (shift: number) =>
      still.slice(20, 140).reduce((sum, v, i) => sum + Math.abs(v - moved[20 + i - shift]), 0);
    const best = [...Array(21).keys()].reduce((a, s) => (mismatch(s) < mismatch(a) ? s : a), 0);
    expect(best).toBeGreaterThanOrEqual(7);
    expect(best).toBeLessThanOrEqual(11);
  });
});
