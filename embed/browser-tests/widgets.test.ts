import { existsSync, readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SHIPPED, TRANSCODER } from "../scripts/bundles.mjs";
import { ROOT } from "./browser";
import { CARD_RGB, cardGlb } from "./ktx2-card";

/**
 * The widgets as built (`npm run build`'s dist/), on a customer's page,
 * against a stand-in for the API on another origin: a photo avatar and a
 * 3D one on the same page, the 3D one with a KTX2 texture. Nothing but the
 * page and the API answers; every other host, jsDelivr included, is
 * blocked. The 3D model must still be drawn with its texture, decoded by
 * the transcoder the API serves beside liveface-3d.js; and the two widgets
 * must come up with their own handles and speak independently
 * (widget/handles.ts).
 */

const PAGE = "https://shop.test";
const API = "https://api.test";
const cues = JSON.parse(readFileSync(`${ROOT}src/__tests__/fixtures/native-cues-hello.json`, "utf8")).cues;

/** What GET /embed/v1/avatars/{id} answers. */
const AVATARS: Record<string, object> = {
  photo: {
    kind: "photo",
    framing: "full",
    rig_url: `${API}/fixtures/human-rig.json`,
    thumbnail_url: `${API}/fixtures/pixels/reference-portrait.webp`,
    image_url: null,
    voice: { provider: "kokoro", voice: "af_heart", locale: "en-US" },
    mouth: null,
    face_type: "human",
  },
  model: {
    kind: "model3d",
    rig_url: "",
    thumbnail_url: "",
    model_url: `${API}/card.glb`,
    voice: { provider: "kokoro", voice: "am_adam", locale: "en-US" },
  },
};

/** `ms` of silence as a 16-bit mono WAV, base64: a voice to play. */
function silence(ms: number, rate = 8000): string {
  const bytes = Math.round((rate * ms) / 1000) * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bytes, 40);
  return wav.toString("base64");
}

/** The customer's page: the model's tag first, then the photo's. */
const HTML =
  `<!doctype html><meta charset=utf-8><body style="margin:0;background:#808080">` +
  `<script>window.readyOnDocument = [];` +
  `document.addEventListener("liveface:ready", (e) => window.readyOnDocument.push(e.detail.avatar));</script>` +
  `<script id="lf-model" src="${API}/liveface.js" data-avatar="model" data-key="lf_model" data-api="${API}" data-size="200"></script>` +
  `<script>document.getElementById("lf-model").addEventListener("liveface:ready", (e) => (window.modelHandle = e.detail));</script>` +
  `<script id="lf-photo" src="${API}/liveface.js" data-avatar="photo" data-key="lf_photo" data-api="${API}" data-size="200"></script>`;

interface Opened {
  page: Page;
  /** Every request the page made, in order. */
  requests: string[];
  /** Each speech request: the key it carried, and what it asked for. */
  synths: { key: string | undefined; text: string; voice: string }[];
  errors: string[];
}

describe("a photo and a 3D widget on one page, with no CDN", () => {
  let browser: Browser;
  const voice = silence(4000);

  beforeAll(async () => {
    for (const file of [...Object.keys(SHIPPED), ...TRANSCODER]) {
      if (!existsSync(`${ROOT}dist/${file}`)) throw new Error(`dist/${file} is missing: run \`npm run build\` first`);
    }
    // As browser.ts launch(), and a voice may play without a click.
    browser = await chromium.launch({
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The page, with both widgets up. */
  async function open(): Promise<Opened> {
    const page = await browser.newPage();
    const opened: Opened = { page, requests: [], synths: [], errors: [] };
    page.on("request", (request) => opened.requests.push(request.url()));
    page.on("pageerror", (error) => opened.errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" || message.text().startsWith("[liveface]")) opened.errors.push(message.text());
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === PAGE) return route.fulfill({ contentType: "text/html", body: HTML });
      // Any other host (a CDN) is unreachable.
      if (url.origin !== API) return route.abort("blockedbyclient");
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-api-key",
        "access-control-allow-methods": "GET, POST",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const answer = (body: string | Buffer, type: string) =>
        route.fulfill({ status: 200, headers: { ...cors, "content-type": type }, body });
      const path = url.pathname;
      const shipped = path.slice(1);
      if (shipped in SHIPPED) return answer(readFileSync(`${ROOT}dist/${shipped}`), "text/javascript");
      if ((TRANSCODER as readonly string[]).includes(shipped)) {
        return answer(
          readFileSync(`${ROOT}dist/${shipped}`),
          shipped.endsWith(".wasm") ? "application/wasm" : "text/javascript"
        );
      }
      if (path.startsWith("/embed/v1/avatars/"))
        return answer(JSON.stringify(AVATARS[path.split("/").pop()!]), "application/json");
      if (path === "/card.glb") return answer(cardGlb(), "model/gltf-binary");
      if (path.startsWith("/fixtures/")) {
        const file = `${ROOT}src/__tests__${path}`;
        return answer(readFileSync(file), path.endsWith(".json") ? "application/json" : "image/webp");
      }
      if (path === "/embed/v1/synthesize") {
        const { text, voice: asked } = request.postDataJSON() as { text: string; voice: string };
        opened.synths.push({ key: request.headers()["x-api-key"], text, voice: asked });
        const payload = { audio_b64: voice, audio_mime: "audio/wav", duration_ms: 4000, cues, cached: false };
        return answer(JSON.stringify(payload), "application/json");
      }
      return route.fulfill({ status: 404, headers: cors, body: "" });
    });
    await page.goto(`${PAGE}/`);
    await page.waitForSelector('canvas[data-liveface="photo"][data-liveface-state=ready]');
    await page.waitForSelector('canvas[data-liveface="model"][data-liveface-state=ready]');
    return opened;
  }

  it("draws the model with its KTX2 texture, decoded by the transcoder beside liveface-3d.js", async () => {
    const { page, requests, errors } = await open();
    // A few frames drawn.
    await page.waitForTimeout(300);
    const shot = await page.locator('canvas[data-liveface="model"]').screenshot();
    const image = await loadImage(shot);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const [r, g, b] = ctx.getImageData(image.width >> 1, image.height >> 1, 1, 1).data;
    // The card's colour, not white (the texture dropped) or the page's grey
    // (nothing drawn).
    expect(Math.abs(r - CARD_RGB[0])).toBeLessThan(16);
    expect(Math.abs(g - CARD_RGB[1])).toBeLessThan(16);
    expect(Math.abs(b - CARD_RGB[2])).toBeLessThan(16);

    // From the API, beside the bundle; nothing from a CDN.
    expect(requests).toContain(`${API}/basis_transcoder.js`);
    expect(requests).toContain(`${API}/basis_transcoder.wasm`);
    expect(requests.filter((url) => !url.startsWith(API) && !url.startsWith(PAGE))).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("gives each widget its own handle, and they speak independently", async () => {
    const { page, synths, errors } = await open();
    /** What the page sees: window.Liveface, and what the page's own
     *  listeners kept. */
    interface Handle {
      speak(t: string): Promise<void>;
      stop(): void;
      isSpeaking(): boolean;
      engine: { isSpeaking(): boolean };
    }
    interface Win {
      Liveface: { get(t: string): Handle | null; all(): { avatar: string }[]; engine: unknown };
      readyOnDocument: string[];
      modelHandle: unknown;
    }

    const handles = await page.evaluate(() => {
      const w = window as unknown as Win;
      const [photo, model] = [w.Liveface.get("photo")!, w.Liveface.get("model")!];
      return {
        all: w.Liveface.all()
          .map((h) => h.avatar)
          .sort(),
        // Each the document heard once (the script tag's event does not bubble).
        heard: [...w.readyOnDocument].sort(),
        // The model's own script tag handed the page its handle.
        modelFromTag: w.modelHandle === model,
        ownEngines: photo.engine !== model.engine,
        // window.Liveface's own calls are the first to come up's.
        firstIsDefault: w.Liveface.engine === w.Liveface.get(w.Liveface.all()[0].avatar)!.engine,
        byCanvas:
          (w.Liveface.get as (t: unknown) => unknown)(document.querySelector('canvas[data-liveface="model"]')) ===
          model,
      };
    });
    expect(handles).toEqual({
      all: ["model", "photo"],
      heard: ["model", "photo"],
      modelFromTag: true,
      ownEngines: true,
      firstIsDefault: true,
      byCanvas: true,
    });

    const speaking = () =>
      page.evaluate(() => {
        const w = window as unknown as Win;
        const [photo, model] = [w.Liveface.get("photo")!, w.Liveface.get("model")!];
        return {
          photo: [photo.isSpeaking(), photo.engine.isSpeaking()],
          model: [model.isSpeaking(), model.engine.isSpeaking()],
        };
      });

    // The photo speaks; the model does not.
    await page.evaluate(() => void (window as unknown as Win).Liveface.get("photo")!.speak("Hello from the photo."));
    await page.waitForFunction(() => (window as unknown as Win).Liveface.get("photo")!.engine.isSpeaking());
    expect((await speaking()).model).toEqual([false, false]);
    // Then the model as well, both at once.
    await page.evaluate(
      () => void (window as unknown as Win).Liveface.get("model")!.speak("And hello from the model.")
    );
    await page.waitForFunction(() => (window as unknown as Win).Liveface.get("model")!.engine.isSpeaking());
    expect(await speaking()).toEqual({ photo: [true, true], model: [true, true] });
    // Each through its own snippet's key and its avatar's voice.
    expect(synths).toEqual([
      { key: "lf_photo", text: "Hello from the photo.", voice: "af_heart" },
      { key: "lf_model", text: "And hello from the model.", voice: "am_adam" },
    ]);

    // Stopping the photo leaves the model speaking.
    await page.evaluate(() => (window as unknown as Win).Liveface.get("photo")!.stop());
    expect(await speaking()).toEqual({ photo: [false, false], model: [true, true] });
    await page.evaluate(() => (window as unknown as Win).Liveface.get("model")!.stop());
    expect(await speaking()).toEqual({ photo: [false, false], model: [false, false] });
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});
