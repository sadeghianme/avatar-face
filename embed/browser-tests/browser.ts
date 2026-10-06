/**
 * What the browser tests share: Chromium as Playwright installs it, WebGL
 * on SwiftShader (the CPU's, so the GPU path renders the same on a laptop
 * and a CI runner without a GPU), a page whose every request is answered
 * from memory or from the repository, and the code under test bundled by
 * esbuild on the spot.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Chromium with WebGL on SwiftShader, whatever GPU the machine has. */
export function launch(): Promise<Browser> {
  return chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
};

/** What one path on the page's origin answers: text, bytes, or a file of the repository. */
export type Answer = string | Buffer | { file: string } | { status: number };

/**
 * Answer every request of `page` to `origin` from `answers` (path ->
 * answer); anything else is a 404, and nothing reaches the network.
 */
export async function serve(page: Page, origin: string, answers: (path: string) => Answer | undefined): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const answer = url.origin === origin ? answers(url.pathname) : undefined;
    if (answer === undefined) return route.fulfill({ status: 404, body: "" });
    if (typeof answer === "object" && "status" in answer) return route.fulfill({ status: answer.status, body: "" });
    const body = typeof answer === "object" && "file" in answer ? readFileSync(`${ROOT}${answer.file}`) : answer;
    const path = typeof answer === "object" && "file" in answer ? answer.file : url.pathname;
    const type = path.endsWith("/") ? TYPES[".html"] : TYPES[extname(path)];
    return route.fulfill({ status: 200, body, contentType: type ?? "application/octet-stream" });
  });
}

/** `entry` bundled as the browser runs it (IIFE), with esbuild options. */
export async function bundle(entry: string, options: Parameters<typeof build>[0] = {}): Promise<string> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    write: false,
    logLevel: "silent",
    ...options,
  });
  return result.outputFiles![0].text;
}

/** RGBA pixels (side x side) as a PNG, to look at a frame that failed. */
export function png(rgba: Uint8ClampedArray, side: number): Buffer {
  const canvas = createCanvas(side, side);
  canvas.getContext("2d").putImageData(new ImageData(rgba, side, side), 0, 0);
  return canvas.toBuffer("image/png");
}

/**
 * Peak signal-to-noise ratio, in dB (Infinity when they are the same), of
 * two RGBA frames as a visitor sees them: over a mid-grey page. Unblended,
 * a cut-out's nearly transparent edge pixels (alpha 1 in 255, say) carry
 * whatever colour rounding left them, and would count as much as the face.
 */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const page = 128;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ka = a[i + 3] / 255;
    const kb = b[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] * ka + page * (1 - ka) - (b[i + c] * kb + page * (1 - kb));
      sum += d * d;
    }
  }
  const mse = sum / ((a.length / 4) * 3);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
