import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bundle, launch, serve } from "./browser";

/**
 * No seam where the turned face meets the picture around it, in Chromium:
 * the GPU warp (WebGL on SwiftShader) and the 2D one, on the committed
 * human photo with a striped collar, as an opaque photo and as a layered
 * avatar (src/__tests__/seam-script.ts, seam-probe.ts; the Skia test,
 * seams.test.ts, holds Node's raster to the same). Every pose at the
 * personality's limits and one mid-sentence: no seam, no tear, no run
 * stepped by more than 3 levels along the face's outline and the neck
 * band's bottom, and the whole turn kept.
 */
const ORIGIN = "https://liveface.test";

describe("the turned face's seams, in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const script = await bundle("browser-tests/harness.ts");
    browser = await launch();
    page = await browser.newPage();
    await serve(page, ORIGIN, (path) => {
      if (path === "/") return "<!doctype html><meta charset=utf-8><body><script src=/harness.js></script>";
      if (path === "/harness.js") return script;
      if (path.startsWith("/fixtures/")) return { file: `src/__tests__${path}` };
      return undefined;
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.seamSubject === "function");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  for (const layered of [false, true]) {
    for (const warp of ["gl", "2d"] as const) {
      it(`are none on ${layered ? "a layered avatar" : "an opaque photo"}, ${warp === "gl" ? "on the GPU" : "in 2D"}`, async () => {
        const frames = await page.evaluate(([l, w]) => window.seamSubject(l, w), [
          layered,
          warp === "gl" ? "auto" : "2d",
        ] as const);
        expect(frames.map((f) => f.path)).toEqual(frames.map(() => warp));
        const found = frames.map((f) => {
          const r = f.report;
          const ok = r.seams === 0 && r.tears === 0 && r.worstStep <= 3 && f.scale === 1;
          return `${f.name}: ${ok ? "clean" : "SEAM"} (${r.seams} seams, ${r.tears} tears of ${r.runs}; worst line ${r.worstLine.toFixed(1)}, step ${r.worstStep.toFixed(1)}; turn kept ${f.scale})`;
        });
        console.info(found.join("\n"));
        expect(found).toEqual(frames.map((f) => expect.stringMatching(new RegExp(`^${f.name}: clean `))));
      }, 120_000);
    }
  }
});
