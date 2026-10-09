import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { vi } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh, type FaceMesh } from "../geometry";
import { addHeadField } from "../head-field";

/**
 * The head's field's tests' fixtures (head-field, head-extent and
 * head-field-turn): the committed portrait, an opaque photo on a plain
 * backdrop, and the same photo cut out along an oval, read with Skia
 * (@napi-rs/canvas), and the face mesh laid on them with the field.
 */
export const FIXTURES = new URL("../../__tests__/fixtures/", import.meta.url);
export const rig = JSON.parse(readFileSync(new URL("human-rig.json", FIXTURES), "utf8")) as Rig;
export const DEG = Math.PI / 180;
export const SIZE = 960;
/** The oval the cut-out keeps, texture px: centre and radii (inside the
 *  picture, through the hair). */
export const OVAL = { cx: 128, cy: 122, rx: 92, ry: 110 };

/** The portrait, and the portrait cut out along OVAL. */
export async function portraits(): Promise<{ photo: HTMLImageElement; cutOut: HTMLImageElement }> {
  const portrait = await loadImage(readFileSync(new URL("pixels/reference-portrait.webp", FIXTURES)));
  const photo = portrait as unknown as HTMLImageElement;
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
  const cutOut = (await loadImage(c.toBuffer("image/png"))) as unknown as HTMLImageElement;
  return { photo, cutOut };
}

/** A document whose canvases are Skia's, for reading the pictures. */
export function stubCanvasDocument(): void {
  vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
}

/** The face mesh on a SIZE stage at `zoom`, with the field laid on it for
 *  `texture` (a cut-out when `cut`). */
export function meshFor(texture: HTMLImageElement, cut: boolean, zoom = 0.5): FaceMesh {
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
