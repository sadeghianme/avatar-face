import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CANONICAL_FACE_CM100 } from "../canonical-face";

/**
 * The canonical face model as the engine decodes it (canonical-face.ts) is
 * the backend's (backend/app/services/head3d/canonical_face_mesh.json, in
 * cm) in hundredths of a centimetre, rounded half to even, value for value.
 *
 * To write the module's text again (a new model): every x's magnitude,
 * then every y, then every z, each value v as DIGITS[(v + 2048) >> 6] +
 * DIGITS[(v + 2048) & 63] (v within -2048 .. 2047); then the x's signs, six
 * to a digit, landmark i's in bit i % 6 of digit i / 6 (1: negative).
 */
const backend = JSON.parse(
  readFileSync(new URL("../../../../backend/app/services/head3d/canonical_face_mesh.json", import.meta.url), "utf8")
) as { vertex_layout: string[]; vertices: number[][] };

/** Round half to even, as the model was rounded. */
const round = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

describe("the canonical face model", () => {
  it("is the backend's 468 vertices, x, y and z in hundredths of a centimetre", () => {
    expect(backend.vertex_layout.slice(0, 3)).toEqual(["x", "y", "z"]);
    expect(backend.vertices).toHaveLength(468);
    expect(CANONICAL_FACE_CM100).toHaveLength(468 * 3);
    backend.vertices.forEach((v, i) => {
      for (let a = 0; a < 3; a++) expect(CANONICAL_FACE_CM100[3 * i + a]).toBe(round(v[a] * 100));
    });
  });

  it("decodes to whole numbers, the nose tip ahead and the ears behind", () => {
    for (const v of CANONICAL_FACE_CM100) expect(Number.isInteger(v)).toBe(true);
    // The nose tip (1) and an ear's tragus (234), z toward the camera.
    expect(CANONICAL_FACE_CM100[3 * 1 + 2]).toBeGreaterThan(700);
    expect(CANONICAL_FACE_CM100[3 * 234 + 2]).toBeLessThan(-200);
  });
});
