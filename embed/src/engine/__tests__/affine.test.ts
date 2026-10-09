import { describe, expect, it } from "vitest";

import { IDENTITY, apply, invert, multiply, rotate, translate, type Affine, type Point } from "../affine";

/**
 * The affine as a 2D context composes it (affine.ts): multiply, translate
 * and rotate are the context's own steps, and the inverse undoes it.
 */
const close = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

describe("the affine as a 2D context composes it", () => {
  const samples: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: -3 },
    { x: -7.5, y: 42 },
    { x: 300, y: 1440 },
  ];

  it("multiply applies the second transform first, as ctx.transform does", () => {
    const m: Affine = { a: 0.9, b: 0.1, c: -0.2, d: 1.1, e: 5, f: -8 };
    const n: Affine = { a: 1.5, b: -0.3, c: 0.4, d: 0.8, e: -20, f: 7 };
    const both = multiply(m, n);
    for (const p of samples) expect(close(apply(both, p), apply(m, apply(n, p)))).toBe(true);
  });

  it("translate and rotate are the context's own steps", () => {
    const m: Affine = { a: 0.9, b: 0.1, c: -0.2, d: 1.1, e: 5, f: -8 };
    const t = translate(m, 12, -34);
    const r = rotate(m, 0.3);
    for (const p of samples) {
      expect(close(apply(t, p), apply(m, { x: p.x + 12, y: p.y - 34 }))).toBe(true);
      const cos = Math.cos(0.3),
        sin = Math.sin(0.3);
      expect(close(apply(r, p), apply(m, { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }))).toBe(true);
    }
  });

  it("the body transform's three steps about a pivot are a rotation that keeps the pivot", () => {
    // translate(pivot) rotate(angle) translate(-pivot, -pivot.y - rise): what
    // applyBodyTransform puts on the context.
    const pivot = { x: 720, y: 2520 },
      angle = 0.02,
      rise = 3;
    let m = translate(IDENTITY, pivot.x, pivot.y);
    m = rotate(m, angle);
    m = translate(m, -pivot.x, -pivot.y - rise);
    // The pivot, lifted by the rise, maps to itself.
    expect(close(apply(m, { x: pivot.x, y: pivot.y + rise }), pivot)).toBe(true);
    // A point at head height moves sideways by sin(angle) * its reach from
    // the pivot (the rise lifts it first, so the reach grows by it).
    const head = { x: 720, y: 500 };
    const moved = apply(m, head);
    expect(moved.x - head.x).toBeCloseTo(Math.sin(angle) * (pivot.y + rise - head.y), 6);
  });

  it("inverts: a point through the affine and back is where it was, into a given affine too", () => {
    const m: Affine = { a: 0.9, b: 0.1, c: -0.2, d: 1.1, e: 5, f: -8 };
    const back = invert(m);
    const into: Affine = { ...IDENTITY };
    expect(invert(m, into)).toBe(into);
    expect(into).toEqual(back);
    for (const p of samples) expect(close(apply(back, apply(m, p)), p)).toBe(true);
    // A singular one has no inverse: the identity stands in.
    expect(invert({ a: 1, b: 2, c: 2, d: 4, e: 3, f: 1 })).toEqual(IDENTITY);
    expect(invert({ a: 1, b: 2, c: 2, d: 4, e: 3, f: 1 }, into)).toEqual(IDENTITY);
  });

  it("applies into a given point, which may be the point itself", () => {
    const m: Affine = { a: 0.9, b: 0.1, c: -0.2, d: 1.1, e: 5, f: -8 };
    for (const p of samples) {
      const want = apply(m, p);
      const q = { ...p };
      expect(apply(m, q, q)).toBe(q);
      expect(q).toEqual(want);
    }
  });
});
