/**
 * The triangle warp on the GPU.
 *
 * The 2D path draws the mesh as one `save / clip(triangle) / transform /
 * drawImage(texture) / restore` per triangle, ~2300 of them a frame on a
 * detected face. Chrome rasterizes those off the JS thread, and at a
 * 1440 px canvas (a 720 px share page at dpr 2) that raster takes longer
 * than a frame every few frames: measured on an M1 Max, 3.4 ms of
 * JavaScript a frame and still 8 ms, 8 ms, 55 ms between frames, a stall
 * every third frame even at rest. The same picture at 720 px ran at 121
 * fps without a stall, so the cost is the raster, not the maths.
 *
 * A texture-mapped triangle mesh is what a GPU does for free. This draws
 * the whole mesh of a frame in ONE draw call into an offscreen WebGL
 * canvas the size of the engine's, and the engine draws that canvas into
 * its 2D canvas once, where the triangle loop used to be; everything else
 * (eyes, lids, lashes, the mouth) stays in 2D on top, untouched.
 *
 * What stays the same as the 2D path, on purpose:
 * - The triangles, in the same order, with the same exclusion: a source
 *   triangle with |det| < 1e-6 in texture space (engine/mesh-warp.ts
 *   drawWarpedTriangle) is skipped here too, once, when the mesh is built.
 * - The body sway and breath and the head's rigid transform: the same
 *   affine the 2D path puts on its context goes in as the vertex matrix,
 *   so the GL canvas is already in canvas pixels and is drawn under the
 *   identity transform, one resample, not two.
 * - Source-over compositing where triangles fold over each other, and
 *   premultiplied alpha, so a cut-out's edge filters like the 2D path's.
 * - Over a picture with transparency only the triangles the face moved
 *   are drawn (select), on both paths (mesh-warp.ts); here they REPLACE
 *   what is under them: the same triangles drawn solid (drawCoverage) erase
 *   the canvas by their coverage, and the mesh is added back.
 *
 * What is different: no seam pads (seam-pad.ts). Adjacent clips in 2D each
 * leave half a pixel of anti-aliased edge that shows the still picture
 * underneath as a hairline, and the pads overlap the triangles to hide it.
 * The GPU rasterizes shared edges exactly, every pixel to one triangle and
 * none to the gap, so there is nothing to hide.
 *
 * The engine keeps the 2D path and takes it whenever this one cannot run:
 * no WebGL, a context lost (until it is restored), a texture that cannot
 * be uploaded (tainted, or past the GPU's size limit), or a page that asks
 * for 2D (`warp: "2d"`, for tests and comparisons).
 */

export interface Point {
  x: number;
  y: number;
}

/** A 2D affine as CanvasRenderingContext2D.transform takes it:
 *  x' = a x + c y + e, y' = b x + d y + f. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Readonly<Affine> = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** `m` after `n`, as `ctx.transform(n)` composes onto a context holding `m`:
 *  points go through `n` first, then `m`. */
export function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

/** `ctx.translate(x, y)` on a context holding `m`. */
export function translate(m: Affine, x: number, y: number): Affine {
  return multiply(m, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
}

/** `ctx.rotate(angle)` on a context holding `m`. */
export function rotate(m: Affine, angle: number): Affine {
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  return multiply(m, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
}

/** Apply an affine to a point. */
export function apply(m: Affine, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * The vertex matrix: canvas pixels through `affine`, then to clip space
 * (-1..1, y up) for a `width` x `height` drawing buffer. Column-major 3x3,
 * as uniformMatrix3fv takes it.
 */
export function clipMatrix(affine: Affine, width: number, height: number): Float32Array {
  const { a, b, c, d, e, f } = affine;
  const sx = 2 / width,
    sy = -2 / height;
  return new Float32Array([a * sx, b * sy, 0, c * sx, d * sy, 0, e * sx - 1, f * sy + 1, 1]);
}

/** The 2D path skips a source triangle this degenerate (drawWarpedTriangle). */
export const MIN_SOURCE_DET = 1e-6;

export interface WarpMesh {
  /** Texture coordinates, normalised 0..1, two per vertex. */
  uv: Float32Array;
  /** Triangle corners, three per triangle, in the 2D path's draw order. */
  indices: Uint16Array | Uint32Array;
  /** Triangles drawn. */
  count: number;
  /** Triangles left out for a degenerate source, as the 2D path leaves them. */
  skipped: number;
}

/**
 * The static half of the mesh: every vertex's texture coordinate and the
 * triangle list, in the order the 2D path draws it, without the triangles
 * it would skip. Built once per geometry; only positions change per frame.
 */
export function buildWarpMesh(
  texPoints: readonly Point[],
  triangles: readonly (readonly [number, number, number])[],
  textureWidth: number,
  textureHeight: number
): WarpMesh {
  const n = texPoints.length;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = texPoints[i].x / textureWidth;
    uv[i * 2 + 1] = texPoints[i].y / textureHeight;
  }
  const kept: number[] = [];
  let skipped = 0;
  for (const [i0, i1, i2] of triangles) {
    const s0 = texPoints[i0],
      s1 = texPoints[i1],
      s2 = texPoints[i2];
    if (!s0 || !s1 || !s2) {
      skipped++;
      continue;
    }
    const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < MIN_SOURCE_DET) {
      skipped++;
      continue;
    }
    kept.push(i0, i1, i2);
  }
  const indices = n <= 0xffff ? Uint16Array.from(kept) : Uint32Array.from(kept);
  return { uv, indices, count: kept.length / 3, skipped };
}

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform mat3 uMatrix;
varying vec2 vUV;
void main() {
  vec3 p = uMatrix * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = aUV;
}`;

// Texture coordinates at mediump (10 bits of mantissa) would land a texel
// or more off across a 1000 px picture; every GPU that matters has highp
// in the fragment shader, and the define says so.
const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform float uSolid;
varying vec2 vUV;
void main() {
  gl_FragColor = mix(texture2D(uTex, vUV), vec4(1.0), uSolid);
}`;

type GL = WebGLRenderingContext;

/** Is WebGL a thing in this environment at all (not in Node, not in jsdom)? */
export function webglSupported(): boolean {
  return typeof WebGLRenderingContext !== "undefined";
}

export class WarpRenderer {
  /** The offscreen drawing buffer, the size of the engine's canvas. */
  readonly canvas: HTMLCanvasElement;
  private gl: GL;
  private program: WebGLProgram | null = null;
  private aPos = -1;
  private aUV = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private uSolid: WebGLUniformLocation | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private uvBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  /** A chosen part of the triangle list (select), rewritten per frame. */
  private subsetBuffer: WebGLBuffer | null = null;
  private subsetCount = 0;
  /** The subset's indices, reused frame to frame. */
  private kept: Uint16Array | Uint32Array | null = null;
  private texture: WebGLTexture | null = null;
  private positions = new Float32Array(0);
  private indexType = 0;
  private count = 0;
  private lost = false;
  private destroyed = false;
  private ready = false;
  /** What is uploaded, kept to upload again after a context restore. */
  private image: TexImageSource | null = null;
  private imageOk = false;
  private mesh: WarpMesh | null = null;
  private readonly onLost: (event: Event) => void;
  private readonly onRestored: () => void;

  /**
   * A renderer with its own context, or null where WebGL is unavailable.
   * Never throws: the engine falls back to 2D on null.
   */
  static create(width: number, height: number): WarpRenderer | null {
    if (!webglSupported()) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const options: WebGLContextAttributes = {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      };
      const gl =
        (canvas.getContext("webgl", options) as GL | null) ??
        (canvas.getContext("experimental-webgl", options) as GL | null);
      // A stand-in canvas (tests) answers getContext with something that is
      // no WebGL context; only the real thing will do.
      if (!gl || !(gl instanceof WebGLRenderingContext)) return null;
      const renderer = new WarpRenderer(canvas, gl);
      return renderer.ready ? renderer : null;
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: GL) {
    this.canvas = canvas;
    this.gl = gl;
    this.onLost = (event: Event) => {
      // Without preventDefault the browser never restores the context.
      event.preventDefault();
      this.lost = true;
      this.ready = false;
    };
    this.onRestored = () => {
      if (this.destroyed) return;
      this.lost = false;
      this.setup();
      if (this.image) this.imageOk = this.upload(this.image);
      if (this.mesh) this.uploadMesh(this.mesh);
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.setup();
  }

  /** Can the next frame be drawn here? */
  get available(): boolean {
    return this.ready && !this.lost && !this.destroyed;
  }

  /** The texture uploaded, and usable. */
  get textureReady(): boolean {
    return this.imageOk;
  }

  /** Triangles the last mesh draws. */
  get triangleCount(): number {
    return this.count;
  }

  private setup(): void {
    const gl = this.gl;
    this.ready = false;
    try {
      const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = this.compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();
      if (!vs || !fs || !program) return;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return;
      }
      this.program = program;
      this.aPos = gl.getAttribLocation(program, "aPos");
      this.aUV = gl.getAttribLocation(program, "aUV");
      this.uMatrix = gl.getUniformLocation(program, "uMatrix");
      this.uSolid = gl.getUniformLocation(program, "uSolid");
      const uTex = gl.getUniformLocation(program, "uTex");
      gl.useProgram(program);
      gl.uniform1i(uTex, 0);
      this.posBuffer = gl.createBuffer();
      this.uvBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();
      this.subsetBuffer = gl.createBuffer();
      // Source-over, premultiplied: where the mesh folds over itself a
      // later triangle composites over an earlier one as the 2D path's
      // drawImage does, and a cut-out's transparent texels add nothing.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
      this.ready = !!(this.posBuffer && this.uvBuffer && this.indexBuffer);
    } catch {
      this.ready = false;
    }
  }

  private compile(kind: number, source: string): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(kind);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  /** Match the engine's canvas; a no-op when it already does. */
  resize(width: number, height: number): void {
    const w = Math.max(1, width),
      h = Math.max(1, height);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /**
   * Upload the picture, replacing the one before. False when it cannot be
   * used (a tainted image, one past the GPU's size limit): the engine draws
   * in 2D until the next texture.
   */
  setTexture(image: TexImageSource): boolean {
    this.image = image;
    this.imageOk = this.available && this.upload(image);
    return this.imageOk;
  }

  private upload(image: TexImageSource): boolean {
    const gl = this.gl;
    try {
      const size = image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
      const w = size.naturalWidth ?? size.width ?? 0,
        h = size.naturalHeight ?? size.height ?? 0;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (!w || !h || w > max || h > max) return false;
      if (this.texture) gl.deleteTexture(this.texture);
      const texture = gl.createTexture();
      if (!texture) return false;
      this.texture = texture;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      // Linear, clamped, no mipmaps: the picture is drawn near its own size,
      // and this is what a non-power-of-two texture allows in WebGL 1.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return gl.getError() === gl.NO_ERROR;
    } catch {
      // A SecurityError for a cross-origin picture without CORS, or any
      // other refusal: the 2D path draws such a picture without reading it.
      return false;
    }
  }

  /** The geometry: texture coordinates and the triangle list. */
  setMesh(mesh: WarpMesh): void {
    this.mesh = mesh;
    this.positions = new Float32Array(mesh.uv.length);
    if (this.available) this.uploadMesh(mesh);
  }

  private uploadMesh(mesh: WarpMesh): void {
    const gl = this.gl;
    try {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      if (mesh.indices instanceof Uint32Array) {
        // More than 65535 vertices: never on a face mesh, but the type must
        // match the buffer, and WebGL 1 needs the extension for it.
        this.indexType = gl.getExtension("OES_element_index_uint") ? gl.UNSIGNED_INT : 0;
      } else {
        this.indexType = gl.UNSIGNED_SHORT;
      }
      this.count = this.indexType ? mesh.count : 0;
    } catch {
      this.count = 0;
    }
  }

  /**
   * Draw the mesh at `points` (canvas px, one per vertex, in the mesh's
   * order) through `affine`, into the offscreen canvas. False when it did
   * not draw (no context, no texture, no mesh): the caller falls back.
   */
  draw(points: readonly Point[], affine: Affine, subset = false): boolean {
    return this.render(points, affine, false, subset);
  }

  /**
   * The same triangles at the same points, rasterized exactly as `draw`
   * rasterizes them, in solid white: the mesh's coverage, 1 inside and the
   * anti-aliased share along its outer edge. What the warp replaces on the
   * canvas where the picture has transparency (mesh-warp.ts).
   */
  drawCoverage(points: readonly Point[], affine: Affine, subset = false): boolean {
    return this.render(points, affine, true, subset);
  }

  /**
   * Choose the triangles the next draws `subset` draw: those of the mesh
   * that `keep` passes, in the mesh's order. How many there are; 0 when
   * none (or nothing could be uploaded).
   */
  select(keep: (a: number, b: number, c: number) => boolean): number {
    const mesh = this.mesh;
    this.subsetCount = 0;
    if (!this.available || !mesh || !this.indexType || !this.subsetBuffer) return 0;
    const all = mesh.indices;
    if (this.kept?.constructor !== all.constructor || this.kept.length !== all.length) {
      this.kept = all instanceof Uint32Array ? new Uint32Array(all.length) : new Uint16Array(all.length);
    }
    const kept = this.kept;
    let n = 0;
    for (let t = 0; t < mesh.count; t++) {
      const a = all[t * 3],
        b = all[t * 3 + 1],
        c = all[t * 3 + 2];
      if (!keep(a, b, c)) continue;
      kept[n * 3] = a;
      kept[n * 3 + 1] = b;
      kept[n * 3 + 2] = c;
      n++;
    }
    if (!n) return 0;
    try {
      const gl = this.gl;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.subsetBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, kept.subarray(0, n * 3), gl.DYNAMIC_DRAW);
      this.subsetCount = n;
    } catch {
      this.subsetCount = 0;
    }
    return this.subsetCount;
  }

  private render(points: readonly Point[], affine: Affine, solid: boolean, subset: boolean): boolean {
    const count = subset ? this.subsetCount : this.count;
    if (!this.available || !this.imageOk || !count || !this.program) return false;
    const gl = this.gl;
    const positions = this.positions;
    const n = Math.min(points.length, positions.length / 2);
    for (let i = 0; i < n; i++) {
      positions[i * 2] = points[i].x;
      positions[i * 2 + 1] = points[i].y;
    }
    try {
      const w = this.canvas.width,
        h = this.canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.enableVertexAttribArray(this.aUV);
      gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix3fv(this.uMatrix, false, clipMatrix(affine, w, h));
      gl.uniform1f(this.uSolid, solid ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, subset ? this.subsetBuffer : this.indexBuffer);
      gl.drawElements(gl.TRIANGLES, count * 3, this.indexType, 0);
      return !gl.isContextLost();
    } catch {
      return false;
    }
  }

  /** Free the GPU objects and the context itself; the renderer is done. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    try {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
      if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      if (this.subsetBuffer) gl.deleteBuffer(this.subsetBuffer);
      if (this.program) gl.deleteProgram(this.program);
      // Browsers allow a handful of live contexts a page; an engine that is
      // mounted and unmounted (React StrictMode, a list of previews) must
      // not hold its context until the garbage collector gets round to it.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.canvas.width = 1;
      this.canvas.height = 1;
    } catch {
      // Already lost: nothing left to free.
    }
    this.texture = null;
    this.posBuffer = this.uvBuffer = this.indexBuffer = this.subsetBuffer = null;
    this.program = null;
    this.image = null;
    this.mesh = null;
  }
}
