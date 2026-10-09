import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { MeshWarp } from "../engine/mesh-warp";
import { engineSeam } from "../engine/seam";
import { IDENTITY, translate, type Point } from "../engine/affine";
import { clipMatrix } from "../engine/warp-gl";
import { MIN_SOURCE_DET, buildWarpMesh } from "../engine/warp-mesh";
import type { Rig } from "../types";

/**
 * The GPU warp (warp-gl.ts): the buffers it builds say the same as the 2D
 * path's triangle loop, the matrix it draws through is the context's own
 * transform, and the engine takes the 2D path whenever the GPU one cannot
 * run: no WebGL at all, a context lost (back on restore), or `warp: "2d"`.
 */

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;

describe("the vertex matrix", () => {
  it("clipMatrix maps canvas pixels through the affine to clip space, y up", () => {
    const w = 1440,
      h = 900;
    const m = clipMatrix(IDENTITY, w, h);
    const to = (p: Point) => ({ x: m[0] * p.x + m[3] * p.y + m[6], y: m[1] * p.x + m[4] * p.y + m[7] });
    const near = (p: Point, q: Point) => {
      expect(p.x).toBeCloseTo(q.x, 6);
      expect(p.y).toBeCloseTo(q.y, 6);
    };
    near(to({ x: 0, y: 0 }), { x: -1, y: 1 });
    near(to({ x: w, y: h }), { x: 1, y: -1 });
    near(to({ x: w / 2, y: h / 2 }), { x: 0, y: 0 });
    // Through a translation: the pixel the affine moves to the centre lands at 0,0.
    const shifted = clipMatrix(translate(IDENTITY, 100, -50), w, h);
    const sx = shifted[0] * (w / 2 - 100) + shifted[3] * (h / 2 + 50) + shifted[6];
    const sy = shifted[1] * (w / 2 - 100) + shifted[4] * (h / 2 + 50) + shifted[7];
    expect(sx).toBeCloseTo(0, 6);
    expect(sy).toBeCloseTo(0, 6);
  });
});

describe("the mesh buffers", () => {
  it("match the engine's triangle list for a real rig, mouth subdivision and neck band included", () => {
    stubBrowser();
    const engine = makeEngine();
    const e = engineSeam(engine);
    const mesh = buildWarpMesh(e.mesh.texPoints, e.mesh.triangles, e.texture.naturalWidth, e.texture.naturalHeight);
    // The 2D path draws a triangle unless its source is degenerate; the
    // fixture's are all drawn, and the GL list is the same list.
    const drawn = e.mesh.triangles.filter(([a, b, c]) => {
      const s0 = e.mesh.texPoints[a],
        s1 = e.mesh.texPoints[b],
        s2 = e.mesh.texPoints[c];
      return Math.abs(s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y)) >= MIN_SOURCE_DET;
    });
    expect(mesh.count).toBe(drawn.length);
    expect(mesh.count + mesh.skipped).toBe(e.mesh.triangles.length);
    expect(e.mesh.triangles.length).toBeGreaterThan(rig.triangles.length); // subdivided, with the neck band
    expect(Array.from(mesh.indices)).toEqual(drawn.flat());
    expect(mesh.uv.length).toBe(e.mesh.texPoints.length * 2);
    engine.destroy();
    restoreBrowser();
  });
});

// --- The engine's choice of path ---------------------------------------------

/** A WebGL context that does nothing, for the engine to think it has one. */
class FakeGL {
  static instances: FakeGL[] = [];
  lost = false;
  calls: string[] = [];
  VERTEX_SHADER = 1;
  FRAGMENT_SHADER = 2;
  COMPILE_STATUS = 3;
  LINK_STATUS = 4;
  ARRAY_BUFFER = 5;
  ELEMENT_ARRAY_BUFFER = 6;
  STATIC_DRAW = 7;
  DYNAMIC_DRAW = 8;
  TEXTURE_2D = 9;
  TEXTURE0 = 10;
  RGBA = 11;
  UNSIGNED_BYTE = 12;
  LINEAR = 13;
  CLAMP_TO_EDGE = 14;
  TEXTURE_MIN_FILTER = 15;
  TEXTURE_MAG_FILTER = 16;
  TEXTURE_WRAP_S = 17;
  TEXTURE_WRAP_T = 18;
  UNPACK_PREMULTIPLY_ALPHA_WEBGL = 19;
  UNPACK_FLIP_Y_WEBGL = 20;
  MAX_TEXTURE_SIZE = 21;
  BLEND = 22;
  ONE = 23;
  ONE_MINUS_SRC_ALPHA = 24;
  DEPTH_TEST = 25;
  CULL_FACE = 26;
  COLOR_BUFFER_BIT = 27;
  FLOAT = 28;
  TRIANGLES = 29;
  UNSIGNED_SHORT = 30;
  UNSIGNED_INT = 31;
  NO_ERROR = 0;
  HIGH_FLOAT = 32;
  constructor() {
    FakeGL.instances.push(this);
  }
  private note(name: string) {
    this.calls.push(name);
  }
  createShader() {
    return {};
  }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() {
    return true;
  }
  createProgram() {
    return {};
  }
  attachShader() {}
  linkProgram() {}
  deleteShader() {}
  getProgramParameter() {
    return true;
  }
  deleteProgram() {}
  getAttribLocation() {
    return 0;
  }
  getUniformLocation() {
    return {};
  }
  useProgram() {}
  uniform1i() {}
  uniform1f(_at: unknown, value: number) {
    this.note(`uniform1f(${value})`);
  }
  uniformMatrix3fv() {}
  createBuffer() {
    return {};
  }
  bindBuffer() {}
  bufferData() {
    this.note("bufferData");
  }
  deleteBuffer() {}
  createTexture() {
    return {};
  }
  bindTexture() {}
  activeTexture() {}
  pixelStorei() {}
  texImage2D() {
    this.note("texImage2D");
  }
  texParameteri() {}
  deleteTexture() {}
  getParameter() {
    return 4096;
  }
  getError() {
    return 0;
  }
  enable() {}
  disable() {}
  blendFunc() {}
  clearColor() {}
  clear() {}
  viewport() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  drawElements(_mode: number, count: number) {
    this.note("drawElements");
    this.note(`drawElements(${count})`);
  }
  isContextLost() {
    return this.lost;
  }
  getExtension() {
    return null;
  }
}

/** A canvas whose 2D context logs its calls and whose WebGL context is a FakeGL. */
function fakeCanvas(log: string[], webgl: boolean) {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  const ctx2d = new Proxy({} as Record<string, unknown>, {
    get: (obj, key: string) =>
      key in obj
        ? obj[key]
        : (...args: unknown[]) => {
            log.push(`${key}(${args.map((a) => (typeof a === "object" && a ? "obj" : String(a))).join(",")})`);
          },
    set: (obj, key: string, value) => ((obj[key] = value), true),
  });
  const canvas = {
    width: 256,
    height: 256,
    getContext: (kind: string) => (kind === "2d" ? ctx2d : webgl && kind === "webgl" ? new FakeGL() : null),
    addEventListener: (type: string, fn: (e: Event) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => undefined,
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {} } as Event);
    },
    getImageData: () => undefined,
  };
  return canvas;
}

let scratch: string[] = [];
function stubBrowser(webgl = false) {
  scratch = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const c = fakeCanvas(scratch, webgl) as unknown as Record<string, unknown>;
      // Scratch canvases read pixels back: one flat colour.
      const ctx = c.getContext as (k: string) => Record<string, unknown>;
      const two = ctx("2d");
      two.getImageData = (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
        for (let i = 0; i < data.length; i += 4) data.set([182, 128, 110, 255], i);
        return { data, width: w, height: h };
      };
      two.createLinearGradient = () => ({ addColorStop() {} });
      two.createRadialGradient = () => ({ addColorStop() {} });
      two.measureText = () => ({ width: 0 });
      return c;
    },
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal(
    "Path2D",
    class {
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
  );
  vi.spyOn(performance, "now").mockReturnValue(10_000);
  if (webgl) vi.stubGlobal("WebGLRenderingContext", FakeGL);
}
function restoreBrowser() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;

function makeEngine(opts: { warp?: "auto" | "2d" } = {}, log: string[] = []) {
  const canvas = fakeCanvas(log, false);
  return new AvatarEngine(canvas as unknown as HTMLCanvasElement, rig, image, { fullPhoto: false, ...opts });
}

describe("which path the engine takes", () => {
  beforeEach(() => {
    FakeGL.instances = [];
  });
  afterEach(restoreBrowser);

  it("is 2D where there is no WebGL, drawing a clipped image per triangle", () => {
    stubBrowser(false);
    const log: string[] = [];
    const engine = makeEngine({}, log);
    expect(engine.warpPath()).toBe("2d");
    log.length = 0;
    engineSeam(engine).render();
    const clips = log.filter((l) => l.startsWith("clip(")).length;
    // Every triangle of the face, the neck band: the head's field
    // (head-field.ts) is drawn only where it moved, and at rest none of it.
    const mesh = engineSeam(engine).mesh;
    expect(clips).toBe(mesh.head ? mesh.head.triangleFrom : mesh.triangles.length);
    expect(FakeGL.instances).toHaveLength(0);
    engine.destroy();
  });

  it("is GL where WebGL works: one texture upload, one draw, one drawImage of the GL canvas", () => {
    stubBrowser(true);
    const log: string[] = [];
    const engine = makeEngine({}, log);
    expect(engine.warpPath()).toBe("gl");
    expect(FakeGL.instances).toHaveLength(1);
    const gl = FakeGL.instances[0];
    log.length = 0;
    engineSeam(engine).render();
    expect(log.filter((l) => l.startsWith("clip(")).length).toBe(0);
    // The GL canvas drawn under the identity, once; the picture once under it.
    expect(log.some((l) => l === "setTransform(1,0,0,1,0,0)")).toBe(true);
    expect(log.filter((l) => l.startsWith("drawImage(")).length).toBe(2);
    expect(gl.calls.filter((c) => c === "texImage2D")).toHaveLength(1);
    expect(gl.calls.filter((c) => c === "drawElements")).toHaveLength(1);
    // The next frame uploads nothing again.
    engineSeam(engine).render();
    expect(gl.calls.filter((c) => c === "texImage2D")).toHaveLength(1);
    expect(gl.calls.filter((c) => c === "drawElements")).toHaveLength(2);
    engine.destroy();
  });

  it("uploads the texture again on setTexture, and the mesh with it", () => {
    stubBrowser(true);
    const engine = makeEngine();
    const gl = FakeGL.instances[0];
    engineSeam(engine).render();
    const uploads = () => gl.calls.filter((c) => c === "texImage2D").length;
    const buffers = () => gl.calls.filter((c) => c === "bufferData").length;
    expect(uploads()).toBe(1);
    const before = buffers();
    engine.setTexture({ naturalWidth: 2048, naturalHeight: 2048, width: 2048, height: 2048 } as HTMLImageElement);
    engineSeam(engine).render();
    expect(uploads()).toBe(2);
    expect(buffers()).toBeGreaterThan(before + 1); // uv + indices again, plus the frame's positions
    engine.destroy();
  });

  it("takes 2D while the context is lost and GL again once it is restored", () => {
    stubBrowser(true);
    const log: string[] = [];
    const engine = makeEngine({}, log);
    const e = engineSeam(engine);
    const glCanvas = e.meshWarp.renderer!.canvas as unknown as { fire(type: string): void };
    e.render();
    expect(log.filter((l) => l.startsWith("clip(")).length).toBe(0);

    glCanvas.fire("webglcontextlost");
    expect(engine.warpPath()).toBe("2d");
    log.length = 0;
    e.render();
    expect(log.filter((l) => l.startsWith("clip(")).length).toBeGreaterThan(1000);

    glCanvas.fire("webglcontextrestored");
    expect(engine.warpPath()).toBe("gl");
    log.length = 0;
    e.render();
    expect(log.filter((l) => l.startsWith("clip(")).length).toBe(0);
    // The restore re-uploaded the texture and the mesh on its own.
    const gl = FakeGL.instances[0];
    expect(gl.calls.filter((c) => c === "texImage2D")).toHaveLength(2);
    engine.destroy();
  });

  it("stays 2D when asked to, and switches live with setWarp", () => {
    stubBrowser(true);
    const log: string[] = [];
    const engine = makeEngine({ warp: "2d" }, log);
    expect(engine.warpPath()).toBe("2d");
    expect(FakeGL.instances).toHaveLength(0);
    engine.setWarp("auto");
    expect(engine.warpPath()).toBe("gl");
    expect(FakeGL.instances).toHaveLength(1);
    engine.setWarp("2d");
    expect(engine.warpPath()).toBe("2d");
    log.length = 0;
    engineSeam(engine).render();
    expect(log.filter((l) => l.startsWith("clip(")).length).toBeGreaterThan(1000);
    engine.destroy();
  });

  it("over a cut-out, draws only what moved, replacing it; over an opaque picture, lays all of it over", () => {
    stubBrowser(true);
    const rest = [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 50, y: 80 },
      { x: 95, y: 85 },
    ];
    const mesh = {
      texPoints: rest,
      basePoints: rest,
      triangles: [
        [0, 1, 2],
        [1, 3, 2],
      ] as [number, number, number][],
      derivedParents: [],
      neckBand: [],
    };
    const texture = { naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 } as HTMLImageElement;
    const canvas = fakeCanvas([], true) as unknown as HTMLCanvasElement;
    // Each copy of the GL canvas, by the composite operation it was drawn with.
    const copies: string[] = [];
    const state = { globalCompositeOperation: "source-over" };
    const ctx = Object.assign(state, {
      save() {},
      restore() {},
      setTransform() {},
      drawImage() {
        copies.push(state.globalCompositeOperation);
      },
    }) as unknown as CanvasRenderingContext2D;
    const frame = (replace: boolean, pts: Point[]) => {
      copies.length = 0;
      const warp = new MeshWarp(canvas, "auto", [], () => ({
        texture,
        mesh: mesh as never,
        padEverywhere: false,
        lowerFace: null,
        replace,
      }));
      const gl = FakeGL.instances[FakeGL.instances.length - 1];
      warp.draw(ctx, pts, IDENTITY);
      const draws = gl.calls.filter((c) => c.startsWith("uniform1f") || c.startsWith("drawElements("));
      warp.destroy();
      return { draws, copies: [...copies] };
    };
    const still = rest.map((p) => ({ ...p }));
    const moved = rest.map((p, i) => (i === 0 ? { x: p.x + 2, y: p.y + 1 } : { ...p }));
    // A cut-out at rest: nothing is drawn, the picture stands.
    expect(frame(true, still)).toEqual({ draws: [], copies: [] });
    // A corner moved: its triangle alone, its coverage (solid) erased with,
    // then the triangle added.
    expect(frame(true, moved)).toEqual({
      draws: ["uniform1f(1)", "drawElements(3)", "uniform1f(0)", "drawElements(3)"],
      copies: ["destination-out", "lighter"],
    });
    // An opaque picture: the whole mesh, laid over, as ever.
    expect(frame(false, still)).toEqual({ draws: ["uniform1f(0)", "drawElements(6)"], copies: ["source-over"] });
  });

  it("frees the renderer with the engine", () => {
    stubBrowser(true);
    const engine = makeEngine();
    const e = engineSeam(engine);
    const warp = e.meshWarp.renderer!;
    expect(warp.available).toBe(true);
    engine.destroy();
    expect(e.meshWarp.renderer).toBeNull();
    expect(warp.available).toBe(false);
  });
});
