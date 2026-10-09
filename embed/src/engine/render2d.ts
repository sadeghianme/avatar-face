/**
 * Composing a frame on the 2D canvas: the picture through the viewport,
 * the head as a rigid unit, the body's sway, and the layered path.
 */
import type { EngineTuning } from "../types";
import { IDENTITY, apply, multiply, rotate, translate, type Affine } from "./affine";
import type { HeadGeom, Point, Rect } from "./geometry";
import type { HeadLayer } from "./head-layer";
import { drawWarpedTriangle } from "./mesh-warp";
import type { BodyLean, HeadOffset } from "./motion";
import type { NeckWarp } from "./neck-blend";

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
 * An opaque picture moves as one, its background with it, so the head's
 * travel is halved and the sway cut to a third: more reads as the camera
 * wobbling, and drags the photo's own edge into frame. A cut-out has no
 * background to wobble: its face travels the head's full distance (as
 * one picture, the bust leaning from low on the chest; or, opted into,
 * its own head layer over the body) and its body sways in full. Layered
 * heads move at full strength: there is real content behind them, so
 * wider travel reveals pixels instead of tearing them, and a layered
 * picture's background genuinely stays still.
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
  /** The head's rectangle and pivots, and its feathered layer (a cut-out's,
   *  when opted into; null otherwise). */
  head: HeadGeom | null;
  headLayer: HeadLayer | null;
  headOffset: HeadOffset;
  bodyLean: BodyLean | null;
  /** A layered avatar's neck warp (neck-blend.ts), updated to this frame's
   *  head motion, and a canvas the stage's size to draw the layers through
   *  it on; null while the head is still on its body (or not layered). */
  neck?: { warp: NeckWarp; scratch: HTMLCanvasElement } | null;
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
  // what makes a shift read as a turn. And the picture moves AS ONE,
  // picture and mesh together, whatever is behind it: there is no second
  // copy of anything, so nothing to seam. A moved copy of the head over
  // the still picture leaves a boundary wherever the copy meets what it
  // covers: over an opaque background a seam at the copy's rectangle and a
  // torn rim at the picture's edge; over a cut-out's transparency a
  // feathered band through the hair, the neck and the shoulders, a cross-
  // fade of two positions of the same strands, which shows as soon as the
  // head moves ("we decided not to cut the photo", 2026-10-07).
  //
  // An opaque picture takes the head's shift and roll whole, about the
  // head's own pivot (its travel is halved: motionTravel). A cut-out's
  // subject is a bust whose edges are all in view, so the same shift
  // would slide the shoulders as far as the face: it leans from low on
  // the chest instead (applyBustTransform), the face travelling as far
  // as the head did and the shoulders a little. The cut-out's own head
  // layer (cutHeadLayer) is kept as an opt-in, for comparison
  // (EngineOptions.cutOutHeadLayer).
  const layered = f.cutOut && geom && headLayer;
  if (!layered && geom) {
    affine = f.cutOut ? applyBustTransform(ctx, geom, head, affine) : applyHeadTransform(ctx, geom, head, affine);
  }

  // Base layer: the whole un-warped photo, through the viewport. Triangle
  // seams and sub-pixel gaps in the warp then reveal original pixels
  // instead of holes, and the hair, shoulders and background are simply
  // there, as far as the canvas reaches.
  drawFullFrame(ctx, f.texture, f.picture);

  if (layered) {
    // The head erased from the base first, by its mask (the share of the
    // head's motion, not the picture's alpha), so the moved layer does not
    // leave a ghost of itself behind.
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(headLayer.mask, headLayer.x, headLayer.y, headLayer.w, headLayer.h);
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.save();
  if (layered) {
    affine = applyHeadTransform(ctx, geom, head, affine);
    // ADDED back, not laid over: the punch-out left base * (1 - m) where
    // the mask is m, and the layer brings the picture * m.
    // Source-over would attenuate the remainder a second time, by
    // (1 - a) again, and the feather band came out a quarter transparent
    // at rest: a faint rectangle around every cut-out's head, over
    // whatever the page showed behind it. Summed, the two are the base
    // again exactly where nothing moved, and the moved copy elsewhere.
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(headLayer.picture, headLayer.x, headLayer.y, headLayer.w, headLayer.h);
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
  const neck = geom ? f.neck : null;
  if (neck) {
    // The body and the head layer through the neck's warp (neck-blend.ts):
    // the head's motion down to the chin, the body's below the neck.
    drawThroughNeck(ctx, layers.body, f.picture, neck.warp, affine, neck.scratch);
    drawThroughNeck(ctx, layers.head, f.picture, neck.warp, affine, neck.scratch);
  } else {
    drawFullFrame(ctx, layers.body, f.picture);
  }

  ctx.save();
  if (geom) affine = applyHeadTransform(ctx, geom, head, affine);
  if (!neck) drawFullFrame(ctx, layers.head, f.picture);

  f.drawMesh(affine);
  f.drawFeatures();
  ctx.restore();
  ctx.restore();
}

/**
 * A full-frame layer drawn through the neck's warp (neck-blend.ts), body
 * frame, then through `body` (the body's sway and breath) onto the canvas.
 * Triangle by triangle onto `scratch`, each REPLACING what is under it
 * there (mesh-warp.ts drawWarpedTriangle: its padded clip's coverage
 * erased, the triangle added), so the overlap that closes the seams
 * between them draws no half-transparent pixel twice (the layers' hair and
 * feathered edges); then the scratch, once, over the canvas.
 */
function drawThroughNeck(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  picture: Rect,
  warp: NeckWarp,
  body: Affine,
  scratch: HTMLCanvasElement
): void {
  const g = scratch.getContext("2d");
  if (!g) return;
  if (scratch.width !== ctx.canvas.width || scratch.height !== ctx.canvas.height) {
    scratch.width = ctx.canvas.width;
    scratch.height = ctx.canvas.height;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, scratch.width, scratch.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  const sx = img.naturalWidth / picture.w,
    sy = img.naturalHeight / picture.h;
  const src = (p: Point): Point => ({ x: (p.x - picture.x) * sx, y: (p.y - picture.y) * sy });
  const W = scratch.width,
    H = scratch.height;
  for (const t of warp.triangles()) {
    const dst = t.moved.map((p) => apply(body, p));
    // Off the stage (a face framing leaves most of a picture outside it):
    // nothing to draw.
    if (
      Math.max(dst[0].x, dst[1].x, dst[2].x) < -2 ||
      Math.min(dst[0].x, dst[1].x, dst[2].x) > W + 2 ||
      Math.max(dst[0].y, dst[1].y, dst[2].y) < -2 ||
      Math.min(dst[0].y, dst[1].y, dst[2].y) > H + 2
    )
      continue;
    drawWarpedTriangle(g, img, t.rest.map(src), dst, 0, 1, 2, 1, true);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Pixel for pixel: a "high" smoothing filter is no identity at 1:1 (a
  // cubic blurs a pixel's width), and on Skia's CPU raster it fringed the
  // picture's edge and dimmed its last column.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0);
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
 * A cut-out's head motion on the whole picture: the bust leans from a
 * pivot low on the chest (HeadGeom.bustPivotY), on the context and on the
 * affine alike.
 *
 * The head's shift (dx, dy) is what the face should travel; the reach
 * from the face's centre down to the pivot is the lever, and everything
 * travels in proportion to its height above the pivot. Sideways, a shear:
 * the face moves by dx, the shoulders (near the pivot) by little, and the
 * shoulders' line stays level. (A rotation by dx / reach, tried first,
 * tipped the shoulders up and down by 8 px at their ends on a 960 px
 * stage while the head turned, a see-saw no body does.) Up and down, a
 * foreshortening about the pivot, 1 - dy / reach, which is how a nod
 * looks from in front: the face dips by dy, the chin a little less than
 * the brow, the shoulders by little, and the picture's lower edge, at or
 * below the pivot, never rises into view. The roll alone is a rotation,
 * the head's tilt, which the face must show. A shear, a scale and a
 * rotation of a few hundredths: the whole picture, nothing torn.
 */
function applyBustTransform(
  ctx: CanvasRenderingContext2D,
  geom: { pivotX: number; bustPivotY: number; bustReach: number },
  head: { dx: number; dy: number; roll: number },
  affine: Affine
): Affine {
  const shear = -head.dx / geom.bustReach;
  const squash = 1 - head.dy / geom.bustReach;
  // (x, y) about the pivot -> (x + shear * y * squash, y * squash), rolled.
  const lean: Affine = { a: 1, b: 0, c: shear * squash, d: squash, e: 0, f: 0 };
  ctx.translate(geom.pivotX, geom.bustPivotY);
  ctx.rotate(head.roll);
  ctx.transform(lean.a, lean.b, lean.c, lean.d, lean.e, lean.f);
  ctx.translate(-geom.pivotX, -geom.bustPivotY);
  let m = translate(affine, geom.pivotX, geom.bustPivotY);
  m = rotate(m, head.roll);
  m = multiply(m, lean);
  return translate(m, -geom.pivotX, -geom.bustPivotY);
}

/**
 * The head's rigid motion relative to the body, as composeFrame draws it:
 * the bust's lean for a cut-out moving as one picture (`bust`), the shift
 * and roll about the head's pivot otherwise (an opaque photo, a layered
 * avatar's head, a cut-out's own head layer). Canvas px to canvas px. The
 * same steps as applyBustTransform and applyHeadTransform put on the
 * affine, for what must follow the head exactly: the 3D turn undoes it
 * (head-turn.ts), a layered neck's warp (neck-blend.ts).
 */
export function headMotionAffine(
  geom: { pivotX: number; pivotY: number; bustPivotY: number; bustReach: number },
  head: { dx: number; dy: number; roll: number },
  bust: boolean
): Affine {
  if (bust) {
    const shear = -head.dx / geom.bustReach;
    const squash = 1 - head.dy / geom.bustReach;
    let m = translate(IDENTITY, geom.pivotX, geom.bustPivotY);
    m = rotate(m, head.roll);
    m = multiply(m, { a: 1, b: 0, c: shear * squash, d: squash, e: 0, f: 0 });
    return translate(m, -geom.pivotX, -geom.bustPivotY);
  }
  let m = translate(IDENTITY, geom.pivotX + head.dx, geom.pivotY + head.dy);
  m = rotate(m, head.roll);
  return translate(m, -geom.pivotX, -geom.pivotY);
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
