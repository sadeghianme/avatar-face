import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, pixelScale, placeHead, refineMesh, validInnerRing, type Point } from "../geometry";
import { LANDMARK_COUNT } from "../landmarks";

/**
 * The face's geometry (geometry.ts): the picture laid on the canvas at a
 * zoom, texture coordinates over the texture's OWN size, the mouth's
 * subdivision and the neck band, the inner-lip ring's guard, and the head
 * as a movable rectangle.
 */

const rig = JSON.parse(readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const [W, H] = rig.image_size;
const image = (width: number, height: number) =>
  ({ naturalWidth: width, naturalHeight: height, width, height }) as HTMLImageElement;
const FULL = image(W, H);
const THUMB = image(256, Math.round((256 * H) / W));
const CANVAS = { width: 600, height: 600 };

describe("layOutFace", () => {
  it("maps the rig to the canvas by one scale and offset, and the picture with it", () => {
    const mesh = layOutFace(rig, FULL, CANVAS, 1, undefined);
    rig.points.forEach(([x, y], i) => {
      expect(mesh.basePoints[i].x).toBeCloseTo(x * mesh.scale + mesh.offsetX, 9);
      expect(mesh.basePoints[i].y).toBeCloseTo(y * mesh.scale + mesh.offsetY, 9);
    });
    expect(mesh.picture).toEqual({ x: mesh.offsetX, y: mesh.offsetY, w: W * mesh.scale, h: H * mesh.scale });
    expect(mesh.triangles).toEqual([]);
    expect(mesh.derivedParents).toEqual([]);
  });

  it("puts texture coordinates over the texture's own size, not the rig's", () => {
    const full = layOutFace(rig, FULL, CANVAS, 1, undefined);
    const thumb = layOutFace(rig, THUMB, CANVAS, 1, undefined);
    rig.points.forEach(([x, y], i) => {
      expect(full.texPoints[i]).toEqual({ x, y });
      expect(thumb.texPoints[i].x).toBeCloseTo((x * 256) / W, 9);
      expect(thumb.texPoints[i].y).toBeCloseTo((y * THUMB.naturalHeight) / H, 9);
    });
    // The framing is the rig's: the same on the canvas whichever texture.
    expect(thumb.basePoints).toEqual(full.basePoints);
  });

  it("composes the face to fill the canvas at zoom 1, and contains the whole picture at 0", () => {
    const face = layOutFace(rig, FULL, CANVAS, 1, undefined);
    const whole = layOutFace(rig, FULL, CANVAS, 0, undefined);
    expect(face.scale).toBeGreaterThan(whole.scale);
    const p = whole.picture;
    expect(p.x).toBeGreaterThanOrEqual(-1e-9);
    expect(p.y).toBeGreaterThanOrEqual(-1e-9);
    expect(p.x + p.w).toBeLessThanOrEqual(CANVAS.width + 1e-9);
    expect(p.y + p.h).toBeLessThanOrEqual(CANVAS.height + 1e-9);
    // The face's own landmarks stay on the canvas at the face zoom.
    for (const q of face.basePoints) {
      expect(q.x).toBeGreaterThan(0);
      expect(q.x).toBeLessThan(CANVAS.width);
    }
  });
});

describe("refineMesh", () => {
  const refined = (texture: HTMLImageElement) => {
    const mesh = layOutFace(rig, texture, CANVAS, 1, undefined);
    refineMesh(mesh, rig, texture);
    return mesh;
  };

  it("adds the mouth's midpoints, each halfway between its parents in the texture", () => {
    const mesh = refined(THUMB);
    expect(mesh.derivedParents.length).toBeGreaterThan(0);
    mesh.derivedParents.forEach(([a, b], k) => {
      const t = mesh.texPoints[LANDMARK_COUNT + k];
      expect(t.x).toBeCloseTo((mesh.texPoints[a].x + mesh.texPoints[b].x) / 2, 9);
      expect(t.y).toBeCloseTo((mesh.texPoints[a].y + mesh.texPoints[b].y) / 2, 9);
    });
    // Each subdivided triangle became four; the rest are kept; then the band.
    const subdivided = mesh.triangles.filter((tri) => tri.some((i) => i >= LANDMARK_COUNT && i < LANDMARK_COUNT + mesh.derivedParents.length));
    expect(subdivided.length % 4).toBe(0);
    const band = mesh.triangles.length - (rig.triangles.length - subdivided.length / 4) - subdivided.length;
    expect(band).toBe(mesh.triangles.filter((tri) => tri.some((i) => i >= LANDMARK_COUNT + mesh.derivedParents.length)).length);
  });

  it("hangs the neck band below the jaw, its texture where the framing says it is", () => {
    const mesh = refined(THUMB);
    expect(mesh.neckBand.length).toBeGreaterThan(0);
    const first = LANDMARK_COUNT + mesh.derivedParents.length;
    expect(mesh.texPoints).toHaveLength(first + mesh.neckBand.length);
    const k = THUMB.naturalWidth / W;
    mesh.neckBand.forEach((v, j) => {
      const t = mesh.texPoints[first + j];
      expect(t.x).toBeCloseTo(((v.base.x - mesh.offsetX) / mesh.scale) * k, 9);
      expect(t.y).toBeCloseTo(((v.base.y - mesh.offsetY) / mesh.scale) * (THUMB.naturalHeight / H), 9);
      expect(v.parent).toBeLessThan(LANDMARK_COUNT);
      expect(v.share).toBeGreaterThanOrEqual(0);
      expect(v.share).toBeLessThan(1);
    });
  });

  it("refines the same triangles whichever texture: only the texture coordinates scale", () => {
    const full = refined(FULL), thumb = refined(THUMB);
    expect(thumb.triangles).toEqual(full.triangles);
    expect(thumb.derivedParents).toEqual(full.derivedParents);
    const k = THUMB.naturalWidth / W;
    full.texPoints.forEach((p, i) => expect(thumb.texPoints[i].x).toBeCloseTo(p.x * k, 6));
  });

  it("keeps the rig's triangles whole when it has no mouth", () => {
    const mouthless = { ...rig, mouth_indices: [] };
    const mesh = layOutFace(mouthless, FULL, CANVAS, 1, undefined);
    refineMesh(mesh, mouthless, FULL);
    expect(mesh.derivedParents).toEqual([]);
    expect(mesh.triangles.slice(0, rig.triangles.length)).toEqual(rig.triangles);
  });
});

describe("pixelScale", () => {
  it("is canvas px per texture px at rest", () => {
    const full = layOutFace(rig, FULL, CANVAS, 1, undefined);
    const thumb = layOutFace(rig, THUMB, CANVAS, 1, undefined);
    expect(pixelScale(full, rig, FULL)).toBeCloseTo(full.scale, 12);
    expect(pixelScale(thumb, rig, THUMB)).toBeCloseTo(thumb.scale / (256 / W), 9);
  });
});

describe("validInnerRing", () => {
  it("keeps a plausible ring", () => {
    expect(validInnerRing(rig)).toEqual(rig.inner_lip_ring);
  });

  it("rebuilds an implausible ring from the mouth's innermost points", () => {
    // A ring wider than the mouth itself: the brows' points.
    const wrong = { ...rig, inner_lip_ring: [55, 65, 52, 285, 295, 282, 70, 300] };
    const ring = validInnerRing(wrong);
    expect(ring).not.toEqual(wrong.inner_lip_ring);
    expect(ring.every((i) => rig.mouth_indices.includes(i))).toBe(true);
    expect(ring).toHaveLength(Math.max(8, Math.floor(rig.mouth_indices.length / 2)));
    expect(validInnerRing({ ...rig, inner_lip_ring: [] })).toEqual(ring);
    expect(validInnerRing({ ...rig, inner_lip_ring: [], mouth_indices: [] })).toEqual([]);
  });
});

describe("placeHead", () => {
  const face: Point[] = [{ x: 200, y: 200 }, { x: 400, y: 200 }, { x: 300, y: 460 }];

  it("is a rectangle round the whole head within the picture, pivoting below the chin", () => {
    const head = placeHead(face, { x: -500, y: -500, w: 2000, h: 2000 })!;
    expect(head.x).toBeCloseTo(200 - 200 * 0.42, 9);
    expect(head.y).toBeCloseTo(200 - 260 * 0.9, 9);
    expect(head.x + head.w).toBeCloseTo(400 + 200 * 0.42, 9);
    expect(head.y + head.h).toBeCloseTo(460 + 260 * 0.5, 9);
    expect(head.pivotX).toBe(300);
    expect(head.pivotY).toBeCloseTo(460 + 260 * 0.85, 9);
    expect(head.faceH).toBe(260);
  });

  it("stops at the picture's edge", () => {
    const head = placeHead(face, { x: 150, y: 100, w: 300, h: 500 })!;
    expect(head.x).toBe(150);
    expect(head.y).toBe(100);
    expect(head.x + head.w).toBe(450);
  });

  it("is nothing for a face too small to move", () => {
    expect(placeHead([{ x: 10, y: 10 }, { x: 12, y: 30 }], { x: 0, y: 0, w: 100, h: 100 })).toBeNull();
  });
});
