/**
 * A cut-out's head cut from its picture as a layer of its own, moved over
 * the still body (EngineOptions.cutOutHeadLayer, an opt-in kept for
 * comparison: by default a cut-out moves as one picture). The frame is
 * composed with it in render2d.ts.
 */
import type { FaceMesh, HeadGeom, Point } from "./geometry";

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
