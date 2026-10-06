import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, env, platform } from "node:process";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GRID, SIZE, SUBJECT_FILES, drift, grid } from "../src/__tests__/frame-script";
import { ROOT, bundle, launch, png, psnr, serve } from "./browser";
import type { PageFrame } from "./harness";

/**
 * The GPU warp's pixels. Most visitors' browsers draw the mesh with WebGL
 * (engine/warp-gl.ts), which the Skia pixel test (src/__tests__/pixels.test.ts)
 * cannot reach: here Chromium draws the same frames of the same committed
 * subjects (src/__tests__/frame-script.ts) through WebGL on SwiftShader and
 * through the forced 2D path, and holds
 *
 *   - every GPU frame to its 2D twin, as a visitor sees them (over a
 *     mid-grey page): PSNR at least MIN_PSNR dB. The two paths sample the
 *     texture differently at triangle edges and antialias a cut-out's
 *     outline differently; measured, every pair is at least 45.9 dB on
 *     macOS and 47.2 dB on Linux, and texture coordinates off by a fifth
 *     of a pixel already bring every subject under 35;
 *   - both paths to this platform's committed goldens: each frame's mean
 *     colour on a 16x16 grid of the canvas and another of the mouth,
 *     within the Skia test's tolerance. Chromium on macOS and on Linux
 *     raster differently (2D cells up to 15 levels apart, measured), more
 *     than one CPU from another, so each platform has its own; CI runs
 *     linux-x64, whose goldens are required there.
 *
 *   npm run test:browser          check
 *   npm run test:browser:update   this platform's goldens from its frames
 *                                 (the PNGs in dist/browser-goldens/ to look at)
 * A frame that fails is written to dist/browser-diffs/.
 */

const GOLDENS = new URL("./fixtures/gl-goldens.json", import.meta.url);
const DIST = `${ROOT}dist/`;
const UPDATE = env.UPDATE_BROWSER_GOLDENS === "1";
const HERE = `${platform}-${arch}`;
const ORIGIN = "https://liveface.test";

/** The two paths' agreement, frame by frame, in dB. */
const MIN_PSNR = 45;
const CELLS = { full: GRID, mouth: GRID };
const TOLERANCE = { full: { max: 4, mean: 0.1 }, mouth: { max: 8, mean: 0.25 } };
const WARPS = ["gl", "2d"] as const;
type Warp = (typeof WARPS)[number];

interface GoldenFrame {
  name: string;
  /** Mean RGB per cell, row by row, base64. */
  full: string;
  mouth: string;
}
interface Goldens {
  "//": string;
  size: number;
  cells: typeof CELLS;
  /** platform -> the browser that drew them, and each subject's frames by path. */
  platforms: Record<string, { browser: string; subjects: Record<string, Record<Warp, GoldenFrame[]>> }>;
}

const rgb = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 !== 3);
const signature = (data: Uint8ClampedArray, mouth: [number, number, number, number], name: string): GoldenFrame => ({
  name,
  full: Buffer.from(rgb(grid(data, [0, 0, SIZE, SIZE], CELLS.full))).toString("base64"),
  mouth: Buffer.from(rgb(grid(data, mouth, CELLS.mouth))).toString("base64"),
});
const file = (subject: string, warp: string, frame: string) =>
  `${subject}-${warp}-${frame.replace(/[^a-z0-9]+/gi, "_")}.png`;

describe("the GPU warp, in Chromium on SwiftShader", () => {
  let browser: Browser;
  let page: Page;
  const goldens: Goldens = existsSync(GOLDENS)
    ? (JSON.parse(readFileSync(GOLDENS, "utf8")) as Goldens)
    : { "//": "", size: SIZE, cells: CELLS, platforms: {} };
  if (UPDATE) goldens.platforms[HERE] = { browser: "", subjects: {} };
  const here = goldens.platforms[HERE];

  beforeAll(async () => {
    const script = await bundle("browser-tests/harness.ts");
    browser = await launch();
    page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await serve(page, ORIGIN, (path) => {
      if (path === "/") return "<!doctype html><meta charset=utf-8><body><script src=/harness.js></script>";
      if (path === "/harness.js") return script;
      if (path.startsWith("/fixtures/")) return { file: `src/__tests__${path}` };
      return undefined;
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.drawSubject === "function");
    expect(errors).toEqual([]);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    if (!UPDATE) return;
    goldens["//"] =
      "Written by npm run test:browser:update (browser-tests/gl-warp.test.ts), one platform at a time, never by hand.";
    here.browser = `chromium ${browser.version()}`;
    writeFileSync(GOLDENS, JSON.stringify(goldens, null, 1) + "\n");
  });

  it("has goldens for every subject and both paths, drawn as the test draws them", () => {
    expect(goldens.size).toBe(SIZE);
    expect(goldens.cells).toEqual(CELLS);
    for (const [name, drawn] of Object.entries(goldens.platforms)) {
      if (UPDATE && name === HERE) continue;
      expect(Object.keys(drawn.subjects).sort(), name).toEqual(Object.keys(SUBJECT_FILES).sort());
    }
    // CI must check its goldens, not skip them.
    if (env.CI) expect(Object.keys(goldens.platforms)).toContain(HERE);
  });

  for (const subject of Object.keys(SUBJECT_FILES)) {
    it(`draws ${subject} on the GPU as in 2D, and both as their goldens`, async () => {
      const drawn = {} as Record<
        Warp,
        { frames: (PageFrame & { data: Uint8ClampedArray })[]; mouth: [number, number, number, number] }
      >;
      for (const warp of WARPS) {
        const result = await page.evaluate(([name, mode]) => window.drawSubject(name, mode), [
          subject,
          warp === "gl" ? "auto" : "2d",
        ] as const);
        drawn[warp] = {
          mouth: result.mouth,
          frames: result.frames.map((f) => ({ ...f, data: new Uint8ClampedArray(Buffer.from(f.rgba, "base64")) })),
        };
        // The path each frame really took: a GPU frame drawn in 2D would
        // pass every check below and prove nothing.
        expect(
          drawn[warp].frames.map((f) => f.path),
          warp
        ).toEqual(drawn[warp].frames.map(() => warp));
      }
      const { gl, "2d": flat } = drawn;
      expect(gl.frames.map((f) => f.name)).toEqual(flat.frames.map((f) => f.name));
      expect(gl.frames).toHaveLength(11);

      const failures: string[] = [];
      const keep = (warp: string, frame: PageFrame & { data: Uint8ClampedArray }) => {
        mkdirSync(`${DIST}browser-diffs`, { recursive: true });
        writeFileSync(`${DIST}browser-diffs/${file(subject, warp, frame.name)}`, png(frame.data, SIZE));
      };
      // The GPU path against the 2D path.
      const agreement = gl.frames.map((frame, i) => psnr(flat.frames[i].data, frame.data));
      agreement.forEach((db, i) => {
        if (db >= MIN_PSNR) return;
        failures.push(`${gl.frames[i].name}: GPU against 2D ${db.toFixed(1)} dB, under ${MIN_PSNR}`);
        keep("gl", gl.frames[i]);
        keep("2d", flat.frames[i]);
      });
      const mean = agreement.reduce((a, b) => a + b, 0) / agreement.length;
      console.info(
        `${subject}: GPU against 2D, PSNR min ${Math.min(...agreement).toFixed(1)} dB, mean ${mean.toFixed(1)} dB`
      );

      // Both against this platform's goldens.
      for (const warp of WARPS) {
        const signatures = drawn[warp].frames.map((f) => signature(f.data, drawn[warp].mouth, f.name));
        if (UPDATE) {
          mkdirSync(`${DIST}browser-goldens`, { recursive: true });
          for (const f of drawn[warp].frames)
            writeFileSync(`${DIST}browser-goldens/${file(subject, warp, f.name)}`, png(f.data, SIZE));
          (here.subjects[subject] ??= {} as Record<Warp, GoldenFrame[]>)[warp] = signatures;
          continue;
        }
        if (!here) {
          console.warn(`no browser goldens for ${HERE}: GPU against 2D only (npm run test:browser:update adds them)`);
          continue;
        }
        const golden = here.subjects[subject][warp];
        expect(signatures.map((s) => s.name)).toEqual(golden.map((g) => g.name));
        signatures.forEach((s, i) => {
          const full = drift(Buffer.from(s.full, "base64"), Buffer.from(golden[i].full, "base64"));
          const mouth = drift(Buffer.from(s.mouth, "base64"), Buffer.from(golden[i].mouth, "base64"));
          const off =
            full.max > TOLERANCE.full.max ||
            full.mean > TOLERANCE.full.mean ||
            mouth.max > TOLERANCE.mouth.max ||
            mouth.mean > TOLERANCE.mouth.mean;
          if (!off) return;
          failures.push(
            `${warp} ${s.name}: whole cells max ${full.max} mean ${full.mean.toFixed(3)}, mouth cells max ${mouth.max} mean ${mouth.mean.toFixed(3)}`
          );
          keep(warp, drawn[warp].frames[i]);
        });
      }
      expect(failures, `${subject} on ${HERE}${here ? `, goldens drawn by ${here.browser}` : ""}`).toEqual([]);
    }, 120_000);
  }
});
