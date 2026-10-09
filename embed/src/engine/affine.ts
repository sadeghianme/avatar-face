/**
 * 2D affines, as the canvas's own transform composes them: the head's
 * rigid motion and the body's lean (render2d.ts), the turn in depth's
 * frame (head-turn.ts), the neck's warp (neck-blend.ts), and the GPU warp's
 * vertex matrix (warp-gl.ts), which must put the mesh exactly where the 2D
 * context would.
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

/** Apply an affine to a point; into `out` when given (which may be `p`). */
export function apply(m: Affine, p: Point, out?: Point): Point {
  const x = p.x,
    y = p.y;
  if (!out) return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  out.x = m.a * x + m.c * y + m.e;
  out.y = m.b * x + m.d * y + m.f;
  return out;
}

/** The inverse of `m` (the identity for a singular one, which no head's
 *  motion is); into `out` when given. */
export function invert(m: Affine, out?: Affine): Affine {
  const { a, b, c, d, e, f } = m;
  const det = a * d - b * c;
  if (!out) {
    if (!det) return { ...IDENTITY };
    return { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det };
  }
  if (!det) return Object.assign(out, IDENTITY);
  out.a = d / det;
  out.b = -b / det;
  out.c = -c / det;
  out.d = a / det;
  out.e = (c * f - d * e) / det;
  out.f = (b * e - a * f) / det;
  return out;
}
