/**
 * Composing a frame on the 2D canvas: the picture through the viewport,
 * the head as a rigid unit, the body's sway, and the layered path.
 */
import type { EngineTuning, Rig } from "../types";
import { IDENTITY, rotate, translate, type Affine } from "./warp-gl";
import type { FaceMesh, HeadGeom, Rect } from "./geometry";
import type { BodyLean, HeadOffset } from "./motion";

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

/** The layered picture (AvatarEngine.setLayers): full-frame images aligned
 *  to the original photo's pixels; a cut-out has no background. */
export interface Layers {
  background?: HTMLImageElement;
  body: HTMLImageElement;
  head: HTMLImageElement;
}

/** Sway is scaled down when the photo still has its background: moving the
 *  whole picture then reads as a wobbling camera rather than a moving person,
 *  and it drags the photo's own edge into frame. */
const OPAQUE_BACKGROUND_SCALE = 0.3;

/**
 * How far the head and the body may move for this picture, as multiples
 * of their full travel, with the tuning's own scales applied.
 *
 * Ghosting: a moved layer over an intact photo leaves a sliver of the
 * original behind it. A cut-out has its head punched out of the base, so
 * it can travel further. Layered heads move at full strength: there is
 * real content behind them, so wider travel reveals pixels instead of
 * tearing them. The body likewise: a cut-out has no edge to expose, and a
 * layered picture's background genuinely stays still.
 */
export function motionTravel(
  layered: boolean,
  cutOut: boolean,
  tuning: Pick<EngineTuning, "headMotion" | "bodyMotion">
): { head: number; body: number } {
  return {
    head: (layered || cutOut ? 1 : 0.5) * tuning.headMotion,
    body: (layered || cutOut ? 1 : OPAQUE_BACKGROUND_SCALE) * tuning.bodyMotion,
  };
}

/** One frame's parts, for composeFrame. */
export interface FrameParts {
  ctx: CanvasRenderingContext2D;
  /** Where the whole picture lies on the canvas (FaceMesh.picture). */
  picture: Rect;
  texture: HTMLImageElement;
  /** The layered picture, or null for the single photo. */
  layers: Layers | null;
  cutOut: boolean;
  /** The head's rectangle and pivot, and its feathered layer (a cut-out's). */
  head: HeadGeom | null;
  headLayer: HTMLCanvasElement | null;
  headOffset: HeadOffset;
  bodyLean: BodyLean | null;
  /** Draw the warped mesh through `affine`, the context's transform as an
   *  affine (mesh-warp.ts). */
  drawMesh(affine: Affine): void;
  /** Paint everything that goes over the mesh, in the head's frame. */
  drawFeatures(): void;
}

/**
 * Compose the frame: the picture (or its layers), the body's lean, the
 * head as a rigid unit, the warped mesh and the features over it.
 *
 * Body motion is applied to the finished picture, not to the mesh.
 *
 * That is the whole point: a rigid transform cannot distort a face. The
 * earlier attempt to move the head warped vertices to fake a rotation,
 * which deformed the features instead of turning them. Sway and breathing
 * are things a camera sees a whole subject do, so moving the whole
 * drawing is not an approximation — it is exactly right.
 */
export function composeFrame(f: FrameParts): void {
  if (f.layers) composeLayered(f, f.layers);
  else composePhoto(f);
}

/** The single photo: the picture with the mesh warped over it. */
function composePhoto(f: FrameParts): void {
  const { ctx, headOffset: head, head: geom, headLayer } = f;
  ctx.save();
  // The same transform is kept as an affine alongside the context's own,
  // for the GPU warp, which draws the mesh through it (drawMesh).
  let affine = applyBodyTransform(ctx, f.bodyLean);

  // --- Head motion ------------------------------------------------------
  //
  // The whole head — hair included — moves as one rigid unit, which is
  // what makes a shift read as a turn. HOW depends on what is behind it.
  // A cut-out has nothing behind its head but transparency: the head is
  // cut out as its own feathered layer, erased from the base and drawn
  // moved, and its edges are the hair's own. A picture with an opaque
  // background has no such edge: a moved copy of the head over the still
  // picture leaves a seam wherever the copy's rectangle meets what it
  // covers, and at the picture's boundary (a scan on white, a portrait
  // on grey) the rotated copy pokes past the edge as a torn, jagged rim.
  // So an opaque picture moves AS ONE, picture and mesh together: there
  // is no second copy, and nothing to seam.
  const asOne = !f.cutOut;
  if (asOne && geom) affine = applyHeadTransform(ctx, geom, head, affine);

  // Base layer: the whole un-warped photo, through the viewport. Triangle
  // seams and sub-pixel gaps in the warp then reveal original pixels
  // instead of holes, and the hair, shoulders and background are simply
  // there, as far as the canvas reaches.
  drawFullFrame(ctx, f.texture, f.picture);

  const layered = !asOne && geom && headLayer;
  if (layered) {
    // The head erased from the base first, so the moved layer does not
    // leave a ghost of itself behind.
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(headLayer, geom.x, geom.y);
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.save();
  if (layered) {
    affine = applyHeadTransform(ctx, geom, head, affine);
    // ADDED back, not laid over: the punch-out left base * (1 - a) where
    // the layer's feathered alpha is a, and the layer brings hair * a.
    // Source-over would attenuate the remainder a second time, by
    // (1 - a) again, and the feather band came out a quarter transparent
    // at rest: a faint rectangle around every cut-out's head, over
    // whatever the page showed behind it. Summed, the two are the base
    // again exactly where nothing moved, and the moved copy elsewhere.
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(headLayer, geom.x, geom.y);
    ctx.globalCompositeOperation = "source-over";
    ctx.translate(head.fdx, head.fdy);
    affine = translate(affine, head.fdx, head.fdy);
  }

  f.drawMesh(affine);
  f.drawFeatures();
  ctx.restore();
  ctx.restore();
}

/**
 * The layered picture: still background, swaying body, moving head.
 *
 * Every layer is real pixels — the body's collar exists under the head,
 * the wall exists behind the hair — so no motion can reveal a hole, and
 * none of the single-photo path's compensations (punch-out, feathered
 * cutout, reduced travel over an attached background) apply. Body sway
 * runs at full strength because the background genuinely stays still,
 * which is exactly what a camera watching a standing person sees.
 */
function composeLayered(f: FrameParts, layers: Layers): void {
  const { ctx, headOffset: head, head: geom } = f;

  if (layers.background) drawFullFrame(ctx, layers.background, f.picture);

  ctx.save();
  let affine = applyBodyTransform(ctx, f.bodyLean);
  drawFullFrame(ctx, layers.body, f.picture);

  ctx.save();
  if (geom) affine = applyHeadTransform(ctx, geom, head, affine);
  drawFullFrame(ctx, layers.head, f.picture);

  f.drawMesh(affine);
  f.drawFeatures();
  ctx.restore();
  ctx.restore();
}

/** Draw a whole full-frame image (the photo, or a layer aligned to it)
 *  through the viewport. */
function drawFullFrame(ctx: CanvasRenderingContext2D, img: HTMLImageElement, picture: Rect): void {
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, picture.x, picture.y, picture.w, picture.h);
}

/**
 * Tip the whole picture about a pivot below the frame, and lift it to
 * breathe (motion.ts bodyLean), on the context and as the affine the GPU
 * warp is given. No lean, no transform.
 */
function applyBodyTransform(ctx: CanvasRenderingContext2D, lean: BodyLean | null): Affine {
  if (!lean) return IDENTITY;
  const { pivot, angle, rise } = lean;
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(angle);
  ctx.translate(-pivot.x, -pivot.y - rise);
  // The same three steps, as the affine the GPU warp is given.
  let m = translate(IDENTITY, pivot.x, pivot.y);
  m = rotate(m, angle);
  return translate(m, -pivot.x, -pivot.y - rise);
}

/**
 * The head's rigid shift and roll about its pivot, on the context and on
 * the affine alike (the GPU warp draws the mesh through the affine).
 */
function applyHeadTransform(
  ctx: CanvasRenderingContext2D,
  geom: { pivotX: number; pivotY: number },
  head: { dx: number; dy: number; roll: number },
  affine: Affine
): Affine {
  ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
  ctx.rotate(head.roll);
  ctx.translate(-geom.pivotX, -geom.pivotY);
  let m = translate(affine, geom.pivotX + head.dx, geom.pivotY + head.dy);
  m = rotate(m, head.roll);
  return translate(m, -geom.pivotX, -geom.pivotY);
}
