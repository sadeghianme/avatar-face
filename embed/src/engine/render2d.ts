/**
 * Composing a frame on the 2D canvas: the picture through the viewport,
 * the head as a rigid unit, the body's sway, and the layered path.
 */
import type { EngineTuning } from "../types";
import { IDENTITY, multiply, rotate, translate, type Affine } from "./warp-gl";
import type { FaceMesh, HeadGeom, Point, Rect } from "./geometry";
import type { BodyLean, HeadOffset } from "./motion";

/**
 * A cut-out's head as its own layer (cutHeadLayer): the share of the head's
 * motion each pixel takes, and the picture weighted by it, both in the
 * texture's own pixels, and where they lie on the canvas.
 */
export interface HeadLayer {
  /** Alpha only: 1 where a pixel moves with the head, 0 where it stays
   *  with the body, feathered between. */
  mask: HTMLCanvasElement;
  /** The picture times the mask, premultiplied: what moves with the head. */
  picture: HTMLCanvasElement;
  /** Where both lie on the canvas, canvas px (the head's frame): the
   *  texture's own pixels scaled as the picture is. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Room left around the mesh inside the mask's whole-weight interior, px:
 *  the deformation moves interior vertices, never past the mesh's rest hull
 *  by more than this. */
const MASK_MESH_MARGIN = 4;

/**
 * Cut the head out of the picture, once: the rectangle of `geom`, grown to
 * hold the whole face mesh (the neck band included) inside its interior,
 * with feathered edges: soft at the sides and top so a moved head blends
 * into the still body, and a deep fade at the neck, where the cross-fade
 * lands on a collar instead of across a chin. Only a cut-out can use one
 * (its head moves over transparency), and only when asked
 * (EngineOptions.cutOutHeadLayer): by default a cut-out moves as one
 * picture, as an opaque one does, because the feathered band itself shows
 * through the hair and the shoulders whenever the head moves.
 *
 * The frame is composed as body x (1 - mask) + head x mask (composePhoto):
 * the mask erases the body's copy, the layer adds the head's. Four rules
 * keep that sum seamless, and each was broken once:
 *
 * - The erase is the MASK, not the layer. Erasing with the layer erased by
 *   the picture's own alpha times the mask, so every half-transparent pixel
 *   of a cut-out's edge (hair strands, the matte's fringe) came out
 *   alpha x (2 - alpha), a bright rim around the hair and the shoulders even
 *   at rest.
 * - The mask's feather reaches its canvas's own edge, in whole pixels. A
 *   fractional rectangle on a canvas rounded up left the last row (or
 *   column) of the layer unfeathered: alpha 113 in a 1440 px stage, a line
 *   that cancelled at rest and split into a bright and a dark hairline
 *   across the chest (and down the shoulder) as soon as the head moved.
 * - The mask is 1 over the whole mesh. The mesh is drawn through the head's
 *   transform; over a feathered band, the picture under it is a blend of
 *   the head's position and the body's, and the neck band's corners, which
 *   reach the hair's outer edge, cut the hair there into a step at every
 *   head shift.
 * - Both are in the TEXTURE's pixels, drawn to the canvas as the picture
 *   itself is (drawFullFrame): one resampling, the same one, for the body's
 *   copy and the head's. A layer resampled once to the canvas when cut and
 *   again every frame came out softer than the body around it, and
 *   differently on each canvas backend.
 */
export function cutHeadLayer(texture: HTMLImageElement, mesh: FaceMesh, geom: HeadGeom): HeadLayer | null {
  // The mesh's extent at rest, every vertex the warp draws (the neck band's
  // too), with room for the deformation; canvas px.
  let mx0 = Infinity,
    my0 = Infinity,
    mx1 = -Infinity,
    my1 = -Infinity;
  const extend = (p: Point) => {
    if (p.x < mx0) mx0 = p.x;
    if (p.x > mx1) mx1 = p.x;
    if (p.y < my0) my0 = p.y;
    if (p.y > my1) my1 = p.y;
  };
  mesh.basePoints.forEach(extend);
  for (const v of mesh.neckBand) extend(v.base);
  mx0 -= MASK_MESH_MARGIN;
  my0 -= MASK_MESH_MARGIN;
  mx1 += MASK_MESH_MARGIN;
  my1 += MASK_MESH_MARGIN;

  // The feather bands, canvas px. Wide at the sides and top: hair routinely
  // crosses them (long or voluminous hair extends well past the face), and a
  // narrow feather turns every head shift into a visible slice through it.
  const side = geom.w * 0.16,
    top = geom.h * 0.13,
    neck = geom.h * 0.26;
  // The rectangle: the head's, grown to keep the mesh and a whole band
  // outside it, within the picture (nothing to move beyond it).
  const pic = mesh.picture;
  const cx0 = Math.max(pic.x, Math.min(geom.x, mx0 - side));
  const cy0 = Math.max(pic.y, Math.min(geom.y, my0 - top));
  const cx1 = Math.min(pic.x + pic.w, Math.max(geom.x + geom.w, mx1 + side));
  const cy1 = Math.min(pic.y + pic.h, Math.max(geom.y + geom.h, my1 + neck));
  // In the texture's own pixels, whole ones: canvas px -> texture px.
  const sx = texture.naturalWidth / pic.w,
    sy = texture.naturalHeight / pic.h;
  const tx = (x: number) => (x - pic.x) * sx,
    ty = (y: number) => (y - pic.y) * sy;
  const x0 = Math.max(0, Math.floor(tx(cx0))),
    y0 = Math.max(0, Math.floor(ty(cy0)));
  const x1 = Math.min(texture.naturalWidth, Math.ceil(tx(cx1))),
    y1 = Math.min(texture.naturalHeight, Math.ceil(ty(cy1)));
  const w = x1 - x0,
    h = y1 - y0;
  if (w < 2 || h < 2) return null;

  const mask = document.createElement("canvas");
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext("2d");
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext("2d");
  if (!mctx || !lctx) return null;

  // The mask: whole, then each band faded out toward its edge. A band the
  // picture's edge cut short is narrower, and never reaches into the mesh.
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, w, h);
  // destination-out with a gradient from the band's inner edge (erase
  // nothing) to the canvas's edge (erase all). Points beyond a gradient's
  // start clamp to its first stop, which is what keeps the interior whole;
  // with the stops reversed the interior clamps to full-erase and the head
  // comes out blank (that shipped once, a silent no-op).
  const fade = (fx0: number, fy0: number, fx1: number, fy1: number) => {
    if (Math.hypot(fx1 - fx0, fy1 - fy0) < 0.5) return;
    const g = mctx.createLinearGradient(fx0, fy0, fx1, fy1);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,1)");
    mctx.fillStyle = g;
    mctx.fillRect(0, 0, w, h);
  };
  const band = (want: number, room: number) => Math.max(0, Math.min(want, room));
  mctx.globalCompositeOperation = "destination-out";
  fade(band(side * sx, tx(mx0) - x0), 0, 0, 0);
  fade(w - band(side * sx, x1 - tx(mx1)), 0, w, 0);
  fade(0, band(top * sy, ty(my0) - y0), 0, 0);
  fade(0, h - band(neck * sy, y1 - ty(my1)), 0, h);
  mctx.globalCompositeOperation = "source-over";

  // The picture's own pixels there, weighted by the mask.
  lctx.drawImage(texture, -x0, -y0);
  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(mask, 0, 0);
  lctx.globalCompositeOperation = "source-over";

  return { mask, picture: layer, x: pic.x + x0 / sx, y: pic.y + y0 / sy, w: w / sx, h: h / sy };
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
