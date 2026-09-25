import { vi } from "vitest";

/**
 * Stand-ins for the browser the embed runs in, shared by the engine, mouth
 * and widget tests: an audio element whose events a test fires, a network
 * that answers each URL as a test says and records what was downloaded, and
 * a canvas that draws nothing but reads back the colour of what was drawn.
 */

/** A stand-in for HTMLAudioElement: the test sets its position and fires
 *  its events. */
export class FakeAudio {
  static last: FakeAudio | null = null;
  currentTime = 0;
  paused = true;
  src: string;
  private listeners = new Map<string, (() => void)[]>();
  constructor(src = "") {
    this.src = src;
    FakeAudio.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  fire(type: string) {
    if (type === "playing") this.paused = false;
    if (type === "pause") this.paused = true;
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

export type Pixel = [number, number, number, number];

/** What one URL answers with. */
export type Resource =
  | { json: unknown }
  | { status: number }
  /** The request itself fails: offline, DNS, CORS. */
  | { offline: true }
  /** An image, all of one colour. */
  | { image: Pixel }
  /** An image the browser cannot decode. */
  | { broken: true };

export interface FakeNetwork {
  /** Every download in order, fetch() and image sources alike. */
  requested: string[];
}

/**
 * Stub `fetch` and `Image` with a network that answers from `resources`;
 * anything else is a 404 (fetch) or a broken image. Aborted requests reject
 * the way a browser's do.
 */
export function stubNetwork(resources: Record<string, Resource>): FakeNetwork {
  const requested: string[] = [];
  const find = (url: string): Resource => resources[url] ?? { status: 404 };
  vi.stubGlobal("fetch", async (input: string | URL, init?: { signal?: AbortSignal | null }) => {
    const url = String(input);
    requested.push(url);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const resource = find(url);
    if ("offline" in resource) throw new TypeError("Failed to fetch");
    if ("json" in resource) {
      return { ok: true, status: 200, json: async () => structuredClone(resource.json) };
    }
    return {
      ok: false,
      status: "status" in resource ? resource.status : 404,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    };
  });

  class NetworkImage {
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1024;
    naturalHeight = 1024;
    width = 1024;
    height = 1024;
    /** The colour a fake canvas reads back where this image was drawn. */
    fill?: Pixel;
    private url = "";
    get src() {
      return this.url;
    }
    set src(url: string) {
      this.url = url;
      requested.push(url);
      const resource = find(url);
      if ("image" in resource) this.fill = resource.image;
      queueMicrotask(() => (this.fill ? this.onload?.() : this.onerror?.()));
    }
    decode() {
      return this.fill
        ? Promise.resolve()
        : Promise.reject(new DOMException("The source image cannot be decoded.", "EncodingError"));
    }
  }
  vi.stubGlobal("Image", NetworkImage);
  return { requested };
}

/**
 * A canvas whose 2D context draws nothing but remembers the last image drawn
 * into it: `getImageData` reads back that image's colour (or `fill` before
 * anything is drawn), so code that samples or extracts pixels sees the
 * picture a test chose.
 */
export function fakeCanvas(fill: Pixel = [180, 180, 180, 180]) {
  let drawn: Pixel | undefined;
  const ctx = new Proxy({
    drawImage: (image: { fill?: Pixel }) => {
      drawn = image.fill ?? drawn;
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      const colour = drawn ?? fill;
      for (let i = 0; i < data.length; i += 4) data.set(colour, i);
      return { data, width: w, height: h };
    },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 0 }),
  } as Record<string, unknown>, {
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value) => ((obj[key] = value), true),
  });
  return {
    width: 256,
    height: 256,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: () => ctx,
    setAttribute() {},
    dispatchEvent: () => true,
  } as unknown as HTMLCanvasElement;
}

/** Path2D is not in Node; nothing here reads a path back. */
export class NoopPath {
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
