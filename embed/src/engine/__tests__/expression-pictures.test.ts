import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCanvas, NoopPath, stubNetwork } from "../../__tests__/browser-fakes";
import type { Rig } from "../../types";
import { ARRIVE_MS, ExpressionPictureLayer } from "../expression-overlay";
import { MaskField, pictureMasks, signedDistance, smoothstep } from "../expression-picture-masks";
import {
  layPicture,
  loadImage,
  loadPictures,
  parseManifest,
  PauseSmile,
  pictureUV,
  type LoadedPicture,
} from "../expression-pictures";
import { ExpressionRig, NONE, type ShapeMix } from "../expression-rig";
import { HUMAN_GAINS, type ShapeName } from "../expression-table";
import { layOutFace, refineMesh, type Point } from "../geometry";

/**
 * The AI expression pictures (expression-pictures.ts, -masks, -overlay):
 * the manifest read and checked, the masks where a picture is laid, the
 * pictures loaded (and left out when one fails), the silent smile's
 * envelope, and the morph under the mask: the landmarks a picture covers
 * go where the picture has them, the rest where the animated expression
 * puts them.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const [W, H] = rig.image_size;
const BASE: Point[] = rig.points.map(([x, y]) => ({ x, y }));
const face = Math.hypot(BASE[454].x - BASE[234].x, BASE[454].y - BASE[234].y);
const mix = (shapes: Partial<Record<ShapeName, number>>): ShapeMix => ({ ...NONE, ...shapes });

/** The picture: the face as the rig has it, at half its size (a crop). */
const UV = BASE.map((p) => ({ x: p.x * 0.5 + 10, y: p.y * 0.5 + 20 }));
const SIZE: [number, number] = [Math.round(W * 0.5) + 20, Math.round(H * 0.5) + 40];
/** Surprise lifts the brows' landmarks by a twentieth of the face. */
const BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const lifted = BASE.map((p, i) => (BROWS.includes(i) ? { x: p.x, y: p.y - face * 0.05 } : { ...p }));
const pairs = (pts: Point[]) => pts.map((p) => [p.x, p.y]);

const manifestJson = () => ({
  version: 1,
  kind: "liveface-expressions",
  kit: "k",
  image_size: [W, H],
  base: pairs(BASE),
  expressions: {
    surprised: { size: SIZE, uv: pairs(UV), targets: pairs(lifted), smile: false },
    happy: { size: SIZE, uv: pairs(UV), targets: pairs(BASE), smile: true },
  },
  recipe: { kit_version: 1 },
});

describe("the manifest", () => {
  it("is read with its pictures' landmarks", () => {
    const m = parseManifest(manifestJson())!;
    expect(m.imageSize).toEqual([W, H]);
    expect(Object.keys(m.entries).sort()).toEqual(["happy", "surprised"]);
    expect(m.entries.happy!.smile).toBe(true);
    expect(m.entries.surprised!.targets[70].y).toBeCloseTo(BASE[70].y - face * 0.05);
  });

  it.each([
    ["not an object", null],
    ["another version", { ...manifestJson(), version: 2 }],
    ["another kind", { ...manifestJson(), kind: "mouth" }],
    ["no base", { ...manifestJson(), base: [[0, 0]] }],
    ["no size", { ...manifestJson(), image_size: [0, 1] }],
    ["a bad point", { ...manifestJson(), base: [[0, "x"], ...pairs(BASE).slice(1)] }],
  ])("refuses %s", (_, json) => {
    expect(parseManifest(json)).toBeNull();
  });

  it("leaves out a broken entry and keeps the others", () => {
    const json = manifestJson();
    (json.expressions.happy as Record<string, unknown>).uv = [];
    const m = parseManifest(json)!;
    expect(Object.keys(m.entries)).toEqual(["surprised"]);
  });
});

describe("the masks", () => {
  const masks = pictureMasks(UV, SIZE, true);
  const at = (field: MaskField, i: number, dx = 0, dy = 0) => field.at({ x: UV[i].x + dx, y: UV[i].y + dy });

  it("cover the brows, the forehead and the cheeks", () => {
    for (const i of [9, 151, 105, 334, 50, 280]) expect(at(masks.upper, i), `landmark ${i}`).toBeGreaterThan(0.6);
  });

  it("leave the eyes' openings, the lips, the chin and the outline alone", () => {
    for (const i of [468, 473, 13, 14, 0, 17, 152, 10, 234, 454])
      expect(at(masks.upper, i), `landmark ${i}`).toBeLessThan(0.08);
  });

  it("give a smiling picture its mouth, and no other picture one", () => {
    expect(at(masks.mouth!, 13)).toBeGreaterThan(0.9);
    expect(at(masks.mouth!, 9)).toBeLessThan(0.01);
    expect(pictureMasks(UV, SIZE, false).mouth).toBeNull();
  });

  it("are fields that read between their cells and say when they are empty", () => {
    const field = new MaskField(2, 1, 10, Float32Array.from([0, 1]));
    expect(field.at({ x: 10, y: 5 })).toBeCloseTo(0.5);
    expect(field.at({ x: -50, y: -50 })).toBe(0);
    expect(field.at({ x: 500, y: 500 })).toBe(1);
    expect(field.empty).toBe(false);
    expect(new MaskField(1, 1, 1, new Float32Array(1)).empty).toBe(true);
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(signedDistance({ x: 5, y: 5 }, square)).toBeCloseTo(-5);
    expect(signedDistance({ x: 13, y: 5 }, square)).toBeCloseTo(3);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });
});

describe("loading", () => {
  afterEach(() => vi.unstubAllGlobals());
  const image = async () => ({ width: SIZE[0], height: SIZE[1] }) as LoadedPicture["image"];

  it("loads each picture the manifest names, and leaves out one that fails", async () => {
    stubNetwork({ "/m.json": { json: manifestJson() } });
    const load = vi.fn(async (url: string) => {
      if (url === "/happy.webp") throw new Error("broken");
      return image();
    });
    const { base, pictures } = await loadPictures(
      { manifestUrl: "/m.json", imageUrls: { surprised: "/s.webp", happy: "/happy.webp", serious: "/x.webp" } },
      load
    );
    expect(base[70]).toEqual(BASE[70]);
    expect(pictures.map((p) => p.name)).toEqual(["surprised"]);
    expect(pictures[0].masks.mouth).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects without a manifest, or with one that is not one", async () => {
    stubNetwork({ "/bad.json": { json: { version: 9 } } });
    await expect(loadPictures({ manifestUrl: "/gone.json", imageUrls: {} }, image)).rejects.toThrow("404");
    await expect(loadPictures({ manifestUrl: "/bad.json", imageUrls: {} }, image)).rejects.toThrow("not an");
  });

  it("asks for each picture with CORS, and says when one cannot be had", async () => {
    stubNetwork({ "/p.webp": { image: [10, 20, 30, 255] } });
    const picture = await loadImage("/p.webp");
    expect(picture.crossOrigin).toBe("anonymous");
    await expect(loadImage("/none.webp")).rejects.toThrow("none.webp");
  });
});

describe("the silent smile", () => {
  it("comes in after a quarter second of silence and goes as the speech heads for a sound", () => {
    const smile = new PauseSmile();
    let t = 0;
    const run = (ms: number, articulation: number) => {
      for (let k = 0; k < ms; k += 10) smile.step((t += 10), articulation);
      return smile.level;
    };
    expect(run(200, 0)).toBe(0);
    expect(run(200, 0)).toBeGreaterThan(0.2);
    expect(run(400, 0)).toBe(1);
    expect(run(50, 0.3)).toBeLessThan(0.5);
    expect(run(60, 0.3)).toBe(0);
    expect(run(100, 0)).toBe(0);
  });
});

describe("a picture on the face", () => {
  const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
  const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
  refineMesh(mesh, rig, image);
  const xr = ExpressionRig.build(mesh.basePoints, rig.triangles, HUMAN_GAINS)!;
  const m = parseManifest(manifestJson())!;
  const picture = (name: "happy" | "surprised"): LoadedPicture => {
    const entry = m.entries[name]!;
    return {
      name,
      entry,
      image: { width: SIZE[0], height: SIZE[1] } as LoadedPicture["image"],
      masks: pictureMasks(entry.uv, entry.size, entry.smile),
    };
  };
  const restPts = () => mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));

  it("is laid in canvas px, its masks read at its landmarks", () => {
    const laid = layPicture(picture("surprised"), m.base, mesh);
    expect(laid.shift[2 * 70 + 1]).toBeCloseTo(-face * 0.05 * mesh.scale, 6);
    expect(laid.shift[2 * 10]).toBe(0);
    expect(laid.upper[105]).toBeGreaterThan(0.6);
    expect(laid.mouth).toBeNull();
    const uv = pictureUV(m.entries.surprised!, mesh, mesh.basePoints.length + mesh.derivedParents.length + 3);
    const [a, b] = mesh.derivedParents[0];
    const k = mesh.basePoints.length;
    expect(uv[k].x).toBeCloseTo((uv[a].x + uv[b].x) / 2);
    expect(uv.length).toBe(k + mesh.derivedParents.length + 3);
  });

  it("moves the landmarks it covers where the picture has them, and the rest as the animation does", () => {
    const layer = new ExpressionPictureLayer([picture("surprised")], m.base, 0, false);
    const pts = restPts();
    expect(layer.apply(pts, mesh, mix({ surprised: 1 }), 1, xr, 1000)).toBe(true);
    const laid = layPicture(picture("surprised"), m.base, mesh);
    // A brow landmark well inside the mask: almost all the picture's move.
    const i = 105;
    const want = mesh.basePoints[i].y + laid.shift[2 * i + 1] * laid.upper[i];
    expect(Math.abs(pts[i].y - want)).toBeLessThan(face * mesh.scale * 0.01);
    // The chin, outside it: the animation's own (surprise's silent jaw has
    // no landmark displacement here; the rig alone moves it).
    const animated = restPts();
    xr.apply(animated, mix({ surprised: 1 }), 1);
    expect(pts[152].y).toBeCloseTo(animated[152].y, 6);
  });

  it("leaves the expressions without a picture to the animation, and moves nothing with none on", () => {
    const layer = new ExpressionPictureLayer([picture("surprised")], m.base, 0, false);
    const pts = restPts();
    layer.apply(pts, mesh, mix({ serious: 1 }), 1, xr, 1000);
    const animated = restPts();
    xr.apply(animated, mix({ serious: 1 }), 1);
    for (let i = 0; i < 478; i++) expect(pts[i].x).toBeCloseTo(animated[i].x, 9);
    expect(layer.apply(restPts(), mesh, NONE, 1, null, 1000)).toBe(false);
  });

  it("comes in over a moment when it arrives, and takes the skin cues of what it shows", () => {
    const layer = new ExpressionPictureLayer([picture("surprised")], m.base, 1000, false);
    expect(layer.names).toEqual(["surprised"]);
    expect(layer.presence(1000)).toBe(0);
    expect(layer.presence(1000 + ARRIVE_MS)).toBe(1);
    const at = (now: number) => {
      const pts = restPts();
      layer.apply(pts, mesh, mix({ surprised: 1 }), 1, xr, now);
      return pts[105].y;
    };
    expect(Math.abs(at(1000 + ARRIVE_MS / 2) - at(1000 + ARRIVE_MS))).toBeGreaterThan(0.1);
    expect(layer.withoutPictures(mix({ surprised: 1, happy: 0.5 }), 5000)).toEqual(mix({ surprised: 0, happy: 0.5 }));
    expect(layer.withoutPictures(mix({ surprised: 1 }), 1000)).toEqual(mix({ surprised: 1 }));
  });

  it("shows a smiling picture's mouth only as far as the silence lets it", () => {
    const layer = new ExpressionPictureLayer([picture("happy")], m.base, 0, false);
    const lip = (smile: number) => {
      layer.smileLevel = smile;
      const pts = restPts();
      layer.apply(pts, mesh, mix({ happy: 1 }), 1, xr, 1000);
      return pts[13];
    };
    const speaking = lip(0);
    const animated = restPts();
    xr.apply(animated, mix({ happy: 1 }), 1);
    expect(speaking.y).toBeCloseTo(animated[13].y, 6);
    // The picture's lips are where the face rests (targets = base here):
    // in the silence the lip goes back toward them.
    const silent = lip(1);
    expect(Math.abs(silent.y - mesh.basePoints[13].y)).toBeLessThan(
      Math.abs(speaking.y - mesh.basePoints[13].y) + 1e-9
    );
  });

  describe("drawn", () => {
    beforeEach(() => {
      vi.stubGlobal("Path2D", NoopPath);
      vi.stubGlobal("document", { createElement: () => fakeCanvas() });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("draws each picture shown on the 2D path, at its weight, and nothing with none on", () => {
      const layer = new ExpressionPictureLayer([picture("surprised"), picture("happy")], m.base, 0, false);
      const canvas = fakeCanvas();
      const ctx = canvas.getContext("2d")! as unknown as CanvasRenderingContext2D & { drawImage: unknown };
      const drawn = vi.spyOn(ctx, "drawImage" as never);
      const pts = mesh.basePoints.map((p) => ({ ...p }));
      const all = [
        ...pts,
        ...mesh.derivedParents.map(([a, b]) => ({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 })),
      ];
      const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      layer.draw(ctx, all, identity, mesh, NONE, 1, 1000);
      expect(drawn).not.toHaveBeenCalled();
      layer.smileLevel = 1;
      layer.draw(ctx, all, identity, mesh, mix({ surprised: 0.5, happy: 1 }), 1, 1000);
      expect(drawn.mock.calls.length).toBeGreaterThan(50);
      // The silent smile's mouth, drawn after the painted mouth: only the
      // smiling picture's, and only while the silence lets it.
      drawn.mockClear();
      layer.smileLevel = 0;
      layer.draw(ctx, all, identity, mesh, mix({ surprised: 1, happy: 1 }), 1, 1000, "mouth");
      expect(drawn).not.toHaveBeenCalled();
      layer.smileLevel = 1;
      layer.draw(ctx, all, identity, mesh, mix({ surprised: 1, happy: 1 }), 1, 1000, "mouth");
      expect(drawn.mock.calls.length).toBeGreaterThan(5);
      layer.destroy();
    });
  });
});
