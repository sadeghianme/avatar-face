/**
 * Composing a frame on the 2D canvas: the picture through the viewport,
 * the head as a rigid unit, the body's sway, and the layered path.
 */
import type { Rig } from "../types";
import type { FaceMesh, HeadGeom } from "./geometry";

/**
 * Cut the head out of the photo, once, as its own layer: the rectangle of
 * `geom`, sampled from the texture with feathered edges: soft at the sides
 * and top so a moved layer blends into the still background, and a deep
 * fade at the neck, where a seam lands on a collar instead of across a
 * chin. Only a cut-out needs one (its head moves over transparency).
 */
export function cutHeadLayer(texture: HTMLImageElement, rig: Rig, mesh: FaceMesh, geom: HeadGeom): HTMLCanvasElement | null {
  const { x, y, w, h } = geom;
  const layer = document.createElement("canvas");
  layer.width = Math.round(w);
  layer.height = Math.round(h);
  const lctx = layer.getContext("2d");
  if (!lctx) return null;

  // The same canvas<->texture mapping the base draw uses.
  const tw = texture.naturalWidth / rig.image_size[0];
  const th = texture.naturalHeight / rig.image_size[1];
  lctx.drawImage(
    texture,
    ((x - mesh.offsetX) / mesh.scale) * tw,
    ((y - mesh.offsetY) / mesh.scale) * th,
    (w / mesh.scale) * tw,
    (h / mesh.scale) * th,
    0, 0, w, h
  );

  // Feather. destination-out with gradients, one per edge; the bottom one
  // is much deeper because that is the neck seam.
  // Each gradient runs from the interior boundary OUT to the canvas edge.
  // destination-out erases where the fill is opaque, so the interior stop
  // must be transparent — and crucially, points beyond a gradient's start
  // clamp to the first stop, which is what keeps the whole interior at
  // "erase nothing". With the stops reversed, the interior clamps to
  // full-erase and the layer comes out blank; that shipped briefly and
  // made this entire feature a silent no-op.
  const fade = (x0: number, y0: number, x1: number, y1: number) => {
    const g = lctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    lctx.fillStyle = g;
    lctx.fillRect(0, 0, w, h);
  };
  lctx.globalCompositeOperation = "destination-out";
  // Wide side/top bands: hair routinely crosses this boundary (long or
  // voluminous hair extends well past the face-derived rect), and a narrow
  // feather there turns every head shift into a visible slice through it.
  const side = w * 0.16, top = h * 0.13, neck = h * 0.26;
  fade(side, 0, 0, 0);
  fade(w - side, 0, w, 0);
  fade(0, top, 0, 0);
  fade(0, h - neck, 0, h);
  lctx.globalCompositeOperation = "source-over";

  return layer;
}
