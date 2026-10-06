import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SIZE, SKIA_BROWSER, SUBJECTS, drawFrames, drift, grid, seededRandom, type Drawn } from "./pixel-frames";

/**
 * Pixels, not draw calls: the real engine draws real frames on Skia's CPU
 * raster in Node (pixel-frames.ts) for three committed subjects — a photo
 * with the classic mouth, the same rig as a toon with the character mouth,
 * a cut-out animal — on a virtual clock and a seeded random, and every
 * frame is held to a committed golden.
 *
 * Each golden is the frame's mean colour on a 16x16 grid of the whole
 * canvas and on a 32x32 grid of the mouth, and, per platform, its SHA-256.
 * Where the goldens hold this platform's hashes, every pixel must match.
 * Elsewhere the grids must agree within a few levels: Skia's SIMD rounds a
 * few edge pixels differently from one CPU to another (measured, arm64
 * against x86_64: never a frame bit-identical, at most 15 levels on a pixel,
 * at most 1 level on a whole-frame cell and 3 on a mouth cell, 0.05 on
 * average), while a lip edge moved, teeth gone or a colour off moves cells
 * by tens.
 *
 * The goldens change only on purpose:
 *   npm run test:pixels:update          new goldens from this platform's frames
 *                                       (the PNGs in dist/pixel-goldens/ to look at)
 *   npm run test:pixels:add-platform    this platform's hashes beside the others,
 *                                       its frames checked against the grids first
 * A frame that fails is written to dist/pixel-diffs/.
 */

const GOLDENS = new URL("./fixtures/pixels/goldens.json", import.meta.url);
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const MODE = process.env.UPDATE_PIXEL_GOLDENS; // "1": all of it; "hashes": this platform's hashes
const HERE = `${platform}-${arch}`;

/** The whole frame's grid and the mouth's, cells per side. */
const CELLS = { full: 16, mouth: 32 };
/** How far a cell's channel may drift, in levels of 255, and all of them
 *  on average, where this platform's hashes are not in the goldens. */
const TOLERANCE = { full: { max: 4, mean: 0.1 }, mouth: { max: 8, mean: 0.25 } };

interface GoldenFrame {
  name: string;
  /** Mean RGB per cell, row by row, base64. */
  full: string;
  mouth: string;
}
interface Goldens {
  "//": string;
  /** The platform the grids were drawn on. */
  platform: string;
  size: number;
  cells: typeof CELLS;
  subjects: Record<string, GoldenFrame[]>;
  /** platform -> subject -> each frame's SHA-256. */
  hashes: Record<string, Record<string, string[]>>;
}

/** RGB of an RGBA grid: alpha follows from colour on a cut-out's clear pixels. */
const rgb = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 !== 3);

function signature(frame: Drawn): GoldenFrame & { sha256: string } {
  return {
    name: frame.name,
    sha256: createHash("sha256").update(frame.data).digest("hex"),
    full: Buffer.from(rgb(grid(frame.data, [0, 0, SIZE, SIZE], CELLS.full))).toString("base64"),
    mouth: Buffer.from(rgb(grid(frame.data, frame.mouth, CELLS.mouth))).toString("base64"),
  };
}

const file = (name: string, frame: string) => `${name}-${frame.replace(/[^a-z0-9]+/gi, "_")}.png`;

describe("the engine's pixels", () => {
  const goldens: Goldens =
    MODE === "1"
      ? { "//": "", platform: HERE, size: SIZE, cells: CELLS, subjects: {}, hashes: { [HERE]: {} } }
      : (JSON.parse(readFileSync(GOLDENS, "utf8")) as Goldens);
  if (MODE === "hashes") goldens.hashes[HERE] = {};

  beforeEach(() => {
    vi.spyOn(Math, "random").mockImplementation(seededRandom());
    for (const [name, value] of Object.entries(SKIA_BROWSER)) vi.stubGlobal(name, value);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    if (!MODE) return;
    goldens["//"] =
      "Written by npm run test:pixels:update / test:pixels:add-platform (src/__tests__/pixels.test.ts), never by hand.";
    writeFileSync(GOLDENS, JSON.stringify(goldens, null, 1) + "\n");
  });

  it("has goldens for every subject, drawn as the test draws them", () => {
    if (MODE === "1") return;
    expect(Object.keys(goldens.subjects).sort()).toEqual(Object.keys(SUBJECTS).sort());
    expect(goldens.size).toBe(SIZE);
    expect(goldens.cells).toEqual(CELLS);
    expect(Object.keys(goldens.hashes)).toContain(goldens.platform);
  });

  for (const [name, subject] of Object.entries(SUBJECTS)) {
    it(`draws ${name} as its goldens`, async () => {
      const clock = { now: 10_000 };
      vi.spyOn(performance, "now").mockImplementation(() => clock.now);
      const drawn = await drawFrames(subject, clock);
      const frames = drawn.map(signature);
      expect(frames).toHaveLength(11);
      // The poses and the scene really changed the picture (a closed mouth
      // may well look like the rest: an animal's does).
      const rest = frames[0].sha256;
      expect(frames.filter((f) => /held (aa|E|ou)|whole/.test(f.name) && f.sha256 === rest).map((f) => f.name)).toEqual(
        []
      );

      if (MODE === "1") {
        // What is being blessed, to look at before committing it.
        mkdirSync(`${DIST}pixel-goldens`, { recursive: true });
        for (const frame of drawn) writeFileSync(`${DIST}pixel-goldens/${file(name, frame.name)}`, frame.png());
        goldens.subjects[name] = frames.map(({ name: frame, full, mouth }) => ({ name: frame, full, mouth }));
        goldens.hashes[HERE][name] = frames.map((f) => f.sha256);
        return;
      }

      const golden = goldens.subjects[name];
      expect(frames.map((f) => f.name)).toEqual(golden.map((f) => f.name));
      const hashes =
        MODE === "hashes" || process.env.PIXELS_GRID_ONLY === "1" ? undefined : goldens.hashes[HERE]?.[name];
      const failures: string[] = [];
      frames.forEach((frame, i) => {
        const full = drift(Buffer.from(frame.full, "base64"), Buffer.from(golden[i].full, "base64"));
        const mouth = drift(Buffer.from(frame.mouth, "base64"), Buffer.from(golden[i].mouth, "base64"));
        const hashOff = hashes !== undefined && frame.sha256 !== hashes[i];
        const gridOff =
          full.max > TOLERANCE.full.max ||
          full.mean > TOLERANCE.full.mean ||
          mouth.max > TOLERANCE.mouth.max ||
          mouth.mean > TOLERANCE.mouth.mean;
        if (!hashOff && !gridOff) return;
        failures.push(
          `${frame.name}: ${hashOff ? "pixels differ; " : ""}whole cells max ${full.max} mean ${full.mean.toFixed(3)}, ` +
            `mouth cells max ${mouth.max} mean ${mouth.mean.toFixed(3)}`
        );
        mkdirSync(`${DIST}pixel-diffs`, { recursive: true });
        writeFileSync(`${DIST}pixel-diffs/${file(name, frame.name)}`, drawn[i].png());
      });
      expect(
        failures,
        `${name}: goldens drawn on ${goldens.platform}, ${hashes ? "with" : "without"} hashes for ${HERE}`
      ).toEqual([]);
      if (MODE === "hashes") goldens.hashes[HERE][name] = frames.map((f) => f.sha256);
    });
  }
});
