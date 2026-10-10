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
  /** An HTTP error; `error` is its JSON body (the API's `{code, detail}`),
   *  else the body is an error page that is not JSON. */
  | { status: number; error?: unknown }
  /** The request itself fails: offline, DNS, CORS. */
  | { offline: true }
  /** An image, all of one colour. */
  | { image: Pixel }
  /** An image the browser cannot decode. */
  | { broken: true };

export interface FakeNetwork {
  /** Every download in order, fetch() and image sources alike. */
  requested: string[];
  /** Every fetch() in order, with the headers it sent. */
  fetches: { url: string; headers: Record<string, string>; body?: string }[];
}

/**
 * Stub `fetch` and `Image` with a network that answers from `resources`;
 * anything else is a 404 (fetch) or a broken image. Aborted requests reject
 * the way a browser's do.
 */
export function stubNetwork(resources: Record<string, Resource>): FakeNetwork {
  const requested: string[] = [];
  const fetches: FakeNetwork["fetches"] = [];
  const find = (url: string): Resource => resources[url] ?? { status: 404 };
  vi.stubGlobal(
    "fetch",
    async (
      input: string | URL,
      init?: { signal?: AbortSignal | null; headers?: Record<string, string>; body?: unknown }
    ) => {
      const url = String(input);
      requested.push(url);
      fetches.push({
        url,
        headers: { ...(init?.headers ?? {}) },
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const resource = find(url);
      if ("offline" in resource) throw new TypeError("Failed to fetch");
      if ("json" in resource) {
        return { ok: true, status: 200, json: async () => structuredClone(resource.json) };
      }
      const error = "error" in resource ? resource.error : undefined;
      return {
        ok: false,
        status: "status" in resource ? resource.status : 404,
        json: async () => {
          if (error === undefined) throw new SyntaxError("Unexpected token '<'");
          return structuredClone(error);
        },
      };
    }
  );

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
  return { requested, fetches };
}

/**
 * A canvas whose 2D context draws nothing but remembers the last image drawn
 * into it: `getImageData` reads back that image's colour (or `fill` before
 * anything is drawn), so code that samples or extracts pixels sees the
 * picture a test chose.
 */
export function fakeCanvas(fill: Pixel = [180, 180, 180, 180]) {
  let drawn: Pixel | undefined;
  const ctx = new Proxy(
    {
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
    } as Record<string, unknown>,
    {
      get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
      set: (obj, key: string, value) => ((obj[key] = value), true),
    }
  );
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

/** A picture whose every pixel a test paints: its size, and its colour at
 *  each of its own pixels. */
export type PaintedImage = HTMLImageElement & { paint(x: number, y: number): Pixel };

export function paintedImage(width: number, height: number, paint: (x: number, y: number) => Pixel): PaintedImage {
  return { naturalWidth: width, naturalHeight: height, width, height, paint } as PaintedImage;
}

/**
 * A canvas whose 2D context reads back what was drawn into it: the last
 * drawImage of a PaintedImage, through that call's source and destination
 * boxes, one source pixel per pixel read (nearest, no filtering). `taint`
 * makes getImageData throw, as a canvas a cross-origin picture was drawn
 * into does; `context: false` makes getContext give nothing.
 */
export function readingCanvas(size = 256, { taint = false, context = true } = {}): HTMLCanvasElement {
  type Drawn = {
    image: PaintedImage;
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    dx: number;
    dy: number;
    dw: number;
    dh: number;
  };
  let drawn: Drawn | null = null;
  const target: Record<string, unknown> = {
    drawImage: (image: PaintedImage, ...a: number[]) => {
      if (typeof image.paint !== "function") return;
      const [w, h] = [image.naturalWidth, image.naturalHeight];
      if (a.length === 2) drawn = { image, sx: 0, sy: 0, sw: w, sh: h, dx: a[0], dy: a[1], dw: w, dh: h };
      else if (a.length === 4) drawn = { image, sx: 0, sy: 0, sw: w, sh: h, dx: a[0], dy: a[1], dw: a[2], dh: a[3] };
      else drawn = { image, sx: a[0], sy: a[1], sw: a[2], sh: a[3], dx: a[4], dy: a[5], dw: a[6], dh: a[7] };
    },
    getImageData: (x: number, y: number, w: number, h: number) => {
      if (taint) throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      const d = drawn;
      if (d) {
        for (let n = 0; n < w * h; n++) {
          const px = x + (n % w),
            py = y + Math.floor(n / w);
          const sx = Math.floor(d.sx + ((px + 0.5 - d.dx) * d.sw) / d.dw);
          const sy = Math.floor(d.sy + ((py + 0.5 - d.dy) * d.sh) / d.dh);
          data.set(d.image.paint(sx, sy), n * 4);
        }
      }
      return { data, width: w, height: h };
    },
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    measureText: () => ({ width: 0 }),
  };
  const ctx = new Proxy(target, {
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value: unknown) => ((obj[key] = value), true),
  });
  return { width: size, height: size, getContext: () => (context ? ctx : null) } as unknown as HTMLCanvasElement;
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
