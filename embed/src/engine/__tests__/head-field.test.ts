import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../../engine";
import { NoopPath } from "../../__tests__/browser-fakes";
import type { Rig } from "../../types";
import { layOutFace, refineMesh, type FaceMesh, type Point } from "../geometry";
import { addHeadField, outlineArc } from "../head-field";
import { POSE_LIMIT_DEG } from "../head-personality";
import { HeadTurn } from "../head-turn";
import { engineSeam } from "../seam";

/**
 * The head's field (head-field.ts): the hair, the ears and the head's
 * outline as a ring of triangles around the face mesh, read off the
 * picture's own pixels (Skia, @napi-rs/canvas), and turning with the face
 * (head-turn.ts): on the committed portrait, an opaque photo on a plain
 * backdrop, and on the same photo cut out along an oval.
 */
const FIXTURES = new URL("../../__tests__/fixtures/", import.meta.url);
const rig = JSON.parse(readFileSync(new URL("human-rig.json", FIXTURES), "utf8")) as Rig;
const DEG = Math.PI / 180;
const SIZE = 960;
let photo: HTMLImageElement;
let cutOut: HTMLImageElement;
/** The oval the cut-out keeps, texture px: centre and radii (inside the
 *  picture, through the hair). */
const OVAL = { cx: 128, cy: 122, rx: 92, ry: 110 };

beforeAll(async () => {
  const portrait = await loadImage(readFileSync(new URL("pixels/reference-portrait.webp", FIXTURES)));
  photo = portrait as unknown as HTMLImageElement;
  const c = createCanvas(portrait.width, portrait.height);
  const g = c.getContext("2d");
  g.drawImage(portrait, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const r = Math.hypot((x - OVAL.cx) / OVAL.rx, (y - OVAL.cy) / OVAL.ry);
      if (r > 1) img.data[(y * c.width + x) * 4 + 3] = 0;
    }
  }
  g.putImageData(img, 0, 0);
  cutOut = (await loadImage(c.toBuffer("image/png"))) as unknown as HTMLImageElement;
});

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
});
afterEach(() => vi.unstubAllGlobals());

/** The face mesh on a SIZE stage at `zoom`, with the field laid on it for
 *  `texture` (a cut-out when `cut`). */
function meshFor(texture: HTMLImageElement, cut: boolean, zoom = 0.5): FaceMesh {
  const mesh = layOutFace(rig, texture, { width: SIZE, height: SIZE }, zoom, undefined);
  refineMesh(mesh, rig, texture);
  const [w, h] = rig.image_size;
  addHeadField(
    mesh,
    rig.triangles,
    { x: texture.naturalWidth / w, y: texture.naturalHeight / h },
    {
      texture,
      cutOut: cut,
      layers: null,
    }
  );
  return mesh;
}

describe("the head's field, laid", () => {
  it("starts at the face's outline from 234 over the top to 454, and ends at the neck band's end columns", () => {
    const arc = outlineArc(rig.triangles, rig.points.length)!;
    expect(arc[0]).toBe(234);
    expect(arc[arc.length - 1]).toBe(454);
    expect(arc).toContain(10);
    expect(arc).not.toContain(152);
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    expect(head).toBeDefined();
    expect(head.spokes.map((s) => s.landmark)).toEqual(arc);
    // Its own vertices come after the neck band's, four to a spoke between
    // the ends, each with its texture position.
    const bandFirst = mesh.basePoints.length + mesh.derivedParents.length;
    expect(head.first).toBe(bandFirst + mesh.neckBand.length);
    expect(head.count).toBe((arc.length - 2) * 4);
    expect(mesh.texPoints).toHaveLength(head.first + head.count);
    // The ends are the band's end columns: 234 and its inner and outer
    // vertices, 454 and its.
    const n = mesh.neckBand.length / 2;
    expect(head.spokes[0].vertices).toEqual([234, bandFirst, bandFirst + n]);
    expect(head.spokes[arc.length - 1].vertices).toEqual([454, bandFirst + n - 1, bandFirst + 2 * n - 1]);
    // Each texture position is the picture's pixel under the vertex at rest.
    const tw = photo.naturalWidth / rig.image_size[0];
    head.vertices.forEach((v, j) => {
      const t = mesh.texPoints[head.first + j];
      expect(((v.base.x - mesh.offsetX) / mesh.scale) * tw).toBeCloseTo(t.x, 6);
    });
  });

  it("gives every one of its triangles a vertex of its own, and leaves the face's as they were", () => {
    const bare = layOutFace(rig, photo, { width: SIZE, height: SIZE }, 0.5, undefined);
    refineMesh(bare, rig, photo);
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    expect(mesh.triangles.slice(0, head.triangleFrom)).toEqual(bare.triangles);
    const own = mesh.triangles.slice(head.triangleFrom);
    expect(own.length).toBeGreaterThan(head.count);
    for (const t of own) expect(Math.max(...t)).toBeGreaterThanOrEqual(head.first);
    // None of them stands on its head at rest: wound one way, none
    // degenerate.
    const at = (i: number): Point =>
      i < mesh.basePoints.length
        ? mesh.basePoints[i]
        : i >= head.first
          ? head.vertices[i - head.first].base
          : mesh.neckBand[i - mesh.basePoints.length - mesh.derivedParents.length].base;
    for (const [a, b, c] of own) {
      const [p, q, r] = [a, b, c].map(at);
      expect((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)).toBeGreaterThan(0);
    }
  });

  it("ends at the hair's edge over a plain backdrop, never past the picture", () => {
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    const pic = mesh.picture;
    for (const s of head.spokes.slice(1, -1)) {
      expect(s.outer).toBeGreaterThan(s.r0);
      const end = { x: head.centre.x + s.dir.x * s.outer, y: head.centre.y + s.dir.y * s.outer };
      expect(end.x).toBeGreaterThan(pic.x);
      expect(end.x).toBeLessThan(pic.x + pic.w);
      expect(end.y).toBeGreaterThan(pic.y);
    }
    // Beside the temples the backdrop shows: the field there ends within a
    // tenth of an eye distance of the hair's edge.
    const side = head.spokes.find((s) => s.landmark === 162)!;
    expect(side.silhouette).toBeLessThan(side.outer + 0.06 * head.iod);
    expect(side.outer - side.silhouette).toBeLessThan(0.1 * head.iod);
  });

  it("on a cut-out, ends a little past the silhouette, in the clear", () => {
    const mesh = meshFor(cutOut, true);
    const head = mesh.head!;
    const k = mesh.scale * (rig.image_size[0] / cutOut.naturalWidth);
    for (const s of head.spokes.slice(1, -1)) {
      // The oval's edge along the spoke, canvas px from the centre.
      const ox = mesh.offsetX + OVAL.cx * k,
        oy = mesh.offsetY + OVAL.cy * k;
      let r = s.r0;
      while (
        Math.hypot(
          (head.centre.x + s.dir.x * r - ox) / (OVAL.rx * k),
          (head.centre.y + s.dir.y * r - oy) / (OVAL.ry * k)
        ) < 1
      )
        r += 0.5;
      if (r >= s.r0 + 1.5 * head.iod) continue;
      expect(Math.abs(s.silhouette - r)).toBeLessThan(0.04 * head.iod);
      expect(s.outer).toBeGreaterThan(s.silhouette);
      expect(s.outer - s.silhouette).toBeLessThanOrEqual(0.12 * head.iod + 1e-6);
    }
  });

  it("is not laid on a picture that cannot be read", async () => {
    const tainted = (await loadImage(
      readFileSync(new URL("pixels/reference-portrait.webp", FIXTURES))
    )) as unknown as HTMLImageElement;
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => {
            throw new Error("SecurityError: tainted");
          },
        }),
      }),
    });
    const mesh = meshFor(tainted, false);
    expect(mesh.head).toBeUndefined();
  });
});

describe("the head's field, turning", () => {
  let mesh: FaceMesh;
  let head: NonNullable<FaceMesh["head"]>;
  let turn: HeadTurn;
  beforeAll(() => {
    vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
    mesh = meshFor(photo, false);
    head = mesh.head!;
    turn = HeadTurn.build(mesh, rig.triangles)!;
    vi.unstubAllGlobals();
  });
  const L = POSE_LIMIT_DEG;
  const rest = () => mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
  /** The frame's every vertex the field reads (the landmarks turned, the
   *  midpoints and the band where they rest), the field pushed after. */
  const turned = (yaw: number, pitch: number) => {
    const pts = rest();
    turn.apply(pts, { yaw: yaw * DEG, pitch: pitch * DEG, roll: 0 }, null, 0);
    const base = mesh.basePoints;
    for (const [a, b] of mesh.derivedParents)
      pts.push({ x: (base[a].x + base[b].x) / 2, y: (base[a].y + base[b].y) / 2 });
    for (const v of mesh.neckBand) pts.push({ ...v.base });
    turn.field(pts);
    return pts;
  };
  const restOf = (i: number): Point =>
    i < mesh.basePoints.length
      ? mesh.basePoints[i]
      : i >= head.first
        ? head.vertices[i - head.first].base
        : mesh.neckBand[i - mesh.basePoints.length - mesh.derivedParents.length].base;
  const moved = (pts: Point[], i: number) => Math.hypot(pts[i].x - restOf(i).x, pts[i].y - restOf(i).y);

  it("rests where it rests", () => {
    const pts = rest();
    for (const [a, b] of mesh.derivedParents) pts.push({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
    for (const v of mesh.neckBand) pts.push({ ...v.base });
    turn.field(pts, true);
    for (let i = head.first; i < head.first + head.count; i++) expect(moved(pts, i)).toBe(0);
  });

  it("takes the face's outline with the turn, and holds its ends below the ears", () => {
    const pts = turned(L.yaw, 0);
    // The forehead's top travels with the face, toward the turn.
    expect(pts[10].x - mesh.basePoints[10].x).toBeGreaterThan(0.05 * turn.iod);
    for (const i of [234, 454, 93, 323]) expect(moved(pts, i)).toBeLessThan(1e-9);
    // A nod takes the forehead down with the face.
    const down = turned(0, L.pitch);
    expect(down[10].y - mesh.basePoints[10].y).toBeGreaterThan(0.02 * turn.iod);
  });

  it("ends still: its outer edge, and the neck band's end columns", () => {
    for (const [yaw, pitch] of [
      [L.yaw, L.pitch],
      [-L.yaw, -L.pitch],
      [L.yaw, 0],
    ]) {
      const pts = turned(yaw, pitch);
      for (const s of head.spokes) expect(moved(pts, s.vertices[s.vertices.length - 1])).toBeLessThan(1e-9);
      for (const i of [...head.spokes[0].vertices, ...head.spokes[head.spokes.length - 1].vertices])
        expect(moved(pts, i)).toBeLessThan(1e-9);
    }
  });

  it("goes with the outline at the hairline and fades out toward the silhouette, the way a turning skull's surface does", () => {
    const pts = turned(L.yaw, 0);
    const top = head.spokes.find((s) => s.landmark === 10)!;
    const along = top.vertices.map((i) => moved(pts, i));
    // Near the outline the hair moves nearly as the forehead does...
    expect(along[1]).toBeGreaterThan(0.6 * along[0]);
    // ...and less and less further out, to nothing where the field ends.
    for (let m = 1; m < along.length; m++) expect(along[m]).toBeLessThanOrEqual(along[m - 1] + 1e-9);
    expect(along[along.length - 1]).toBe(0);
  });

  it("folds none of its triangles and keeps most of the outline's travel at the limits", () => {
    for (const yaw of [-L.yaw, 0, L.yaw]) {
      for (const pitch of [-L.pitch, 0, L.pitch]) {
        if (!yaw && !pitch) continue;
        turned(yaw, pitch);
        expect(turn.stats.headMinAreaRatio).toBeGreaterThan(0.4);
        expect(turn.stats.scale).toBe(1);
        // The temples' band of hair is narrow on this portrait: at the
        // corners its cap keeps four fifths of their travel.
        expect(turn.stats.headMinShare).toBeGreaterThan(0.75);
      }
    }
  });

  it("caps what a narrow band of hair is asked to take", () => {
    // Far past the limits, the outline would cross the hair's band: its
    // travel is held to what the band takes.
    turned(30, 0);
    expect(turn.stats.headCapped).toBeGreaterThan(0);
    expect(turn.stats.headMinShare).toBeLessThan(1);
    expect(turn.stats.headMinAreaRatio).toBeGreaterThan(0);
  });
});

describe("the engine lays the head's field", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });

  it("for the turn in depth only: a person's photo has it, the rigid layer and a cartoon do not", () => {
    const canvas = createCanvas(SIZE, SIZE) as unknown as HTMLCanvasElement;
    const person = new AvatarEngine(canvas, structuredClone(rig), photo, { warp: "2d", faceType: "human" });
    expect(engineSeam(person).mesh.head).toBeDefined();
    person.setHeadMotion("2d");
    expect(engineSeam(person).mesh.head).toBeUndefined();
    person.setHeadMotion("3d");
    expect(engineSeam(person).mesh.head).toBeDefined();
    person.destroy();
    const cartoon = new AvatarEngine(canvas, structuredClone(rig), photo, { warp: "2d", faceType: "cartoon" });
    expect(cartoon.headMotion()).toBe("2d");
    expect(engineSeam(cartoon).mesh.head).toBeUndefined();
    cartoon.destroy();
  });
});
