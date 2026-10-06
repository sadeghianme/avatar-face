import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bundleOptions } from "../scripts/bundles.mjs";
import { mangledNames } from "../scripts/mangle-names.mjs";
import { ROOT, launch, serve } from "./browser";

/**
 * liveface.js as shipped, with its private members renamed
 * (scripts/mangle-names.mjs), against the same bundle with every name as
 * written: on a customer's page, against a stand-in for the API, each draws
 * the same frames, pixel for pixel. A name renamed that something outside
 * the bundle reads (the API's answers, the mouth bundle, the page) changes
 * a frame here, or throws. Two avatars: a photo with the continuous mouth
 * from liveface-mouth.js (the engine and the mouth bundle trading objects),
 * and a cut-out animal with a character mouth over a published scene.
 */

const ORIGIN = "https://shop.test";
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const cues = JSON.parse(read("src/__tests__/fixtures/native-cues-hello.json")).cues;

/** What GET /embed/v1/avatars/{id} answers for each avatar. */
const AVATARS: Record<string, object> = {
  photo: {
    kind: "photo",
    framing: "full",
    rig_url: "/fixtures/human-rig.json",
    thumbnail_url: "/fixtures/pixels/reference-portrait.webp",
    image_url: null,
    voice: { provider: "kokoro", voice: "af_heart", locale: "en-US" },
    mouth: { renderer: "continuous", profile: { jawRange: 0.8 }, oral: null },
  },
  animal: {
    kind: "photo",
    framing: "face",
    scene: { zoom: 0.6, pan: { x: 0.04, y: -0.02 }, background: { kind: "color", color: "#204060" } },
    rig_url: "/fixtures/fitted-animal-rig.json",
    thumbnail_url: "/fixtures/pixels/animal-realistic.webp",
    image_url: null,
    voice: null,
    mouth: { renderer: "classic", character: { jaw: 1.3, teeth: "both", tongue: true } },
  },
};

/**
 * Before any of the page's scripts: a seeded random, a clock that moves
 * only when the test steps it, the frame loop's callbacks held for the test
 * to run, and the mouth bundle's attach() watched, so the test knows when
 * the continuous mouth is in place.
 */
function pageClock() {
  let now = 10_000;
  let seed = 7;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  performance.now = () => now;
  let frames: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (callback) => frames.push(callback);
  window.cancelAnimationFrame = () => undefined;
  const page = window as unknown as Record<string, unknown>;
  page.step = (n: number) => {
    for (let i = 0; i < n; i++) {
      now += 16;
      const due = frames;
      frames = [];
      for (const callback of due) callback(now);
    }
  };
  page.frameHash = async () => {
    const canvas = document.querySelector("canvas[data-liveface]") as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) opaque++;
    return { hash: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""), opaque };
  };
  let mouth: { attach: (...args: unknown[]) => Promise<unknown> } | undefined;
  Object.defineProperty(window, "__LivefaceMouth", {
    configurable: true,
    get: () => mouth,
    set: (bundle: { attach: (...args: unknown[]) => Promise<unknown> }) => {
      mouth = { attach: (...args) => (page.mouthAttached = bundle.attach(...args)) };
    },
  });
}

describe("liveface.js with its names renamed", () => {
  let browser: Browser;
  const bundles: Record<"renamed" | "as written" | "mouth", string> = { renamed: "", "as written": "", mouth: "" };

  beforeAll(async () => {
    const names = await mangledNames(ROOT);
    const text = async (options: Parameters<typeof build>[0]) =>
      (await build({ ...options, write: false, logLevel: "silent" })).outputFiles![0].text;
    bundles.renamed = await text(bundleOptions(ROOT, "liveface.js", names));
    bundles["as written"] = await text(bundleOptions(ROOT, "liveface.js"));
    bundles.mouth = await text(bundleOptions(ROOT, "liveface-mouth.js"));
    browser = await launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it("renames names: the two bundles differ", () => {
    expect(bundles.renamed.length).toBeLessThan(bundles["as written"].length - 2000);
  });

  /** Boot `avatar` on a page with liveface.js `variant`, and draw its frames. */
  async function frames(variant: "renamed" | "as written", avatar: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    // The page's errors, and the widget's own warnings (not Chromium's
    // notes on readbacks).
    page.on("console", (message) => {
      if (message.type() === "error" || message.text().startsWith("[liveface]")) errors.push(message.text());
    });
    await page.addInitScript(pageClock);
    await serve(page, ORIGIN, (path) => {
      if (path === "/") {
        return `<!doctype html><meta charset=utf-8><body style="margin:0">` +
          `<script src="/liveface.js" data-avatar="${avatar}" data-key="lf_test" data-api="${ORIGIN}" data-size="256"></script>`;
      }
      if (path === "/liveface.js") return bundles[variant];
      if (path === "/liveface-mouth.js") return bundles.mouth;
      if (path === `/embed/v1/avatars/${avatar}`) return JSON.stringify(AVATARS[avatar]);
      if (["/mouth-motion.json", "/mouth-teeth.webp", "/mouth-teeth.rig.json"].includes(path)) return { file: `assets${path}` };
      if (path.startsWith("/fixtures/")) return { file: `src/__tests__${path}` };
      return undefined;
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForSelector("canvas[data-liveface-state=ready]");
    // The continuous mouth arrives on its own, after the face: in place
    // before the first frame is read, in both runs alike.
    if ((AVATARS[avatar] as { mouth: { renderer: string } }).mouth.renderer === "continuous") {
      await page.waitForFunction(() => (window as unknown as { mouthAttached?: unknown }).mouthAttached !== undefined);
      await page.evaluate(() => (window as unknown as { mouthAttached: Promise<unknown> }).mouthAttached);
    }

    const shot = () => page.evaluate(() => (window as unknown as { frameHash: () => Promise<{ hash: string; opaque: number }> }).frameHash());
    const step = (n: number) => page.evaluate((count) => (window as unknown as { step: (n: number) => void }).step(count), n);
    const drawn: { name: string; hash: string; opaque: number }[] = [];
    const take = async (name: string) => drawn.push({ name, ...(await shot()) });

    await step(60);
    await take("rest");
    // Speech, through the page's API (window.Liveface.engine).
    await page.evaluate((track) => (window as unknown as { Liveface: { engine: { playCues(c: unknown): void } } }).Liveface.engine.playCues(track), cues);
    for (const at of [10, 20, 30, 40]) {
      await step(at === 10 ? 10 : 10);
      await take(`speech +${at} frames`);
    }
    await page.evaluate(() => (window as unknown as { Liveface: { stop(): void; engine: { stopSpeech(): void } } }).Liveface.engine.stopSpeech());
    await page.evaluate(() =>
      (window as unknown as { Liveface: { tune(t: object): void } }).Liveface.tune({ mouthOpen: 1.2, headMotion: 0.5 })
    );
    await step(30);
    await take("tuned, at rest");
    const path = await page.evaluate(() => (window as unknown as { Liveface: { engine: { warpPath(): string } } }).Liveface.engine.warpPath());
    await page.close();
    return { drawn, errors, path };
  }

  for (const avatar of Object.keys(AVATARS)) {
    it(`draws the ${avatar} avatar the same, renamed or not`, async () => {
      const written = await frames("as written", avatar);
      const renamed = await frames("renamed", avatar);
      expect(written.errors).toEqual([]);
      expect(renamed.errors).toEqual([]);
      expect(written.path).toBe("gl");
      // Real frames: a face on the canvas, moving as it speaks.
      expect(Math.min(...written.drawn.map((f) => f.opaque))).toBeGreaterThan(256 * 256 * 0.2);
      expect(new Set(written.drawn.map((f) => f.hash)).size).toBeGreaterThan(3);
      expect(renamed.drawn).toEqual(written.drawn);
    }, 120_000);
  }
});
