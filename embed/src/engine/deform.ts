/**
 * The face's deformation: where every mesh vertex is this frame, from the
 * rest mesh and the face state. The mouth (the classic field, or a
 * character profile's own), the lids, a smile reaching the eyes, the brows,
 * a mouth extension's own pass, the lower face, then the derived vertices.
 *
 * Head pose is not here: it is applied at render time as a rigid layer
 * transform (render2d.ts). Warping vertices for it is how the face ended
 * up sliding around inside a stationary head.
 */
import { blinkEase } from "../blink";
import type { CharacterField, CharacterTraits } from "../character-mouth";
import { applyLowerFace, UPPER_FACE, type LowerFaceRig } from "../jaw-rig";
import type { KindProfile } from "../kind-profile";
import type { MouthExtension } from "../mouth-extension";
import type { BlendWeights, EngineTuning, Rig } from "../types";
import type { FaceMesh, Point } from "./geometry";
import { EYE_CORNERS, LEFT_BROW, LOWER_LIDS, RIGHT_BROW, UPPER_LIDS } from "./landmarks";
import type { FaceState } from "./state";

/**
 * How far the upper lids lower when the gaze goes down, as a fraction of
 * the blink sweep. Eyes that look down with the lids fixed open show more
 * white above the iris, which is the startled look; real lids follow the
 * eye. Small: a glance down is a narrowing, not a half-blink.
 */
const LID_FOLLOW = 0.35;

/**
 * Jaw drop at full jawOpen, as a fraction of resting mouth height, for
 * every point below the seam. 0.74 is what the old gradient delivered at
 * the lip's bottom edge, so the chin travels the same distance as before;
 * what changes is that the whole lower lip now travels with it.
 */
const JAW_DROP = 0.74;

const MOUTH_CORNERS = new Set([61, 291, 78, 308, 76, 306, 62, 292]);

// MediaPipe lip landmarks, outer and inner rows. Membership decides which
// side of the hinge a vertex is on.
const LOWER_LIP = new Set([
  146, 91, 181, 84, 17, 314, 405, 321, 375, // outer
  95, 88, 178, 87, 14, 317, 402, 318, 324, // inner
]);
const UPPER_LIP = new Set([
  185, 40, 39, 37, 0, 267, 269, 270, 409, // outer
  191, 80, 81, 82, 13, 312, 311, 310, 415, // inner
]);

/**
 * How much of the jaw drop a vertex takes, 0..1.
 *
 * One lateral taper shared by lip and skin alike: the mouth corners are
 * anchored to the cheeks, so the drop fades from full at the centre to
 * nothing just past the corners, and every vertex at the same x agrees —
 * the first version tapered the lip by x but ramped the skin by y, so a
 * lip vertex and the skin vertex beside it disagreed by 30px across one
 * triangle, which rendered as a row of spikes along each side of the lip.
 *
 * - Lower lip: the taper, fully.
 * - Corners: half. A commissure descends about half the jaw drop when the
 *   mouth opens wide; anchoring it completely made the lip come to a
 *   torn point.
 * - Upper lip: still, except a small droop toward the corners, where it
 *   is pulled by the descending commissure.
 * - Skin: nothing above the seam; below it, the taper, once a short ramp
 *   past the lip line has ruled out the mid-lip region.
 */
export function hingeShare(index: number, nx: number, ny: number, lensWidth: number): number {
  // A LENS, not a plateau: an open mouth's lower edge is deepest at the
  // centre and curves up to meet the corners. A flat-topped taper left the
  // lip beside each corner dropping three quarters of the way while the
  // corner itself stayed, and that step is what rendered as spikes.
  // `lensWidth` narrows the lens for rounded shapes: an "oh" opens the
  // middle of the mouth, not the corners.
  const lateral = Math.max(0, 1 - Math.pow(Math.abs(nx) / lensWidth, 2.2));
  if (LOWER_LIP.has(index)) return lateral;
  if (MOUTH_CORNERS.has(index)) return 0.5 * lateral;
  if (UPPER_LIP.has(index)) {
    return 0.3 * Math.max(0, Math.min(1, (Math.abs(nx) - 0.4) / 0.6)) * lateral;
  }
  if (ny <= 0) return 0;
  const t = Math.min(1, ny / 0.35);
  return t * t * (3 - 2 * t) * lateral;
}

/**
 * How far the upper lid travels, as a fraction of the way to the lower lid.
 *
 * There is no drawn lid any more. Every attempt to synthesise one from a
 * single photo added an artifact: sliding a band of skin down duplicates
 * whatever is above the eye (on a face with drawn eyeliner, that is a second
 * eyelash), and painting a filled shape reads as a sticker. Both put an extra
 * layer over a face that never had one.
 *
 * So the blink is the mesh alone, and the only thing that makes that work is
 * NOT closing all the way. A full sweep crushes the eyeball texture into a
 * band and smears it. A short one reads as the quick narrowing a blink
 * actually is at this size, moves the real lashes (they are part of the lid
 * texture, so they travel with it), and never reaches the range where the
 * squash becomes visible.
 *
 * (A profile that blinks with a painted lid, blink-lid.ts, leaves the mesh
 * still: paint-eyes.ts draws the lid.)
 */
const LID_VERTEX_SWEEP = 1.0;

/** Everything the deformation reads. */
export interface DeformInput {
  rig: Rig;
  mesh: FaceMesh;
  innerRing: readonly number[];
  face: FaceState;
  tuning: EngineTuning;
  profile: KindProfile;
  /** The character mouth's field, for a profile that has one. */
  field: CharacterField | null;
  traits: CharacterTraits;
  lowerFace: LowerFaceRig | null;
  mouthExtension: MouthExtension | undefined;
}

/** Every vertex of the mesh this frame, canvas px, in vertex order. */
export function deformFace(f: DeformInput): Point[] {
  const { mesh, face, tuning } = f;
  const pts = mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
  const w = face.weights;

  const mouth = mouthBox(pts, f.rig.mouth_indices);
  // A character profile moves the mouth with its own field instead.
  if (!f.field) classicMouth(pts, mouth, f.innerRing, w, tuning.mouthOpen);
  if (f.field) f.field.apply(pts, w, tuning.mouthOpen, f.traits);

  // (The jaw, the chin and the cheeks come after every driver, below:
  // applyLowerFace. The outward cheek push that lived here pushed the
  // cheeks the wrong way — an opening jaw narrows the face.)

  // Face half-height, for expression amplitudes.
  const ys = pts.map((p) => p.y);
  const fh = (Math.max(...ys) - Math.min(...ys)) / 2;

  // Lids also follow a downward gaze a little (LID_FOLLOW), so the
  // deformation runs whenever either is non-zero.
  const lidFollow = Math.max(0, Math.min(0.5, face.gaze.y)) * LID_FOLLOW;
  if ((face.blink > 0 || lidFollow > 0) && f.profile.blink === "mesh") {
    // Asymmetric ease: lids snap shut faster than they reopen — blink.ts.
    blinkLids(pts, Math.min(1, blinkEase(face.blink) + lidFollow), tuning.blink);
  }

  // NOTE: gaze is NOT applied to iris vertices — the iris and the sclera
  // around it share one triangulated mesh, so moving those vertices drags
  // the whole socket and reads as wall-eyed smearing. The iris is drawn
  // as a separate layer instead (paint-eyes.ts drawGaze), which is how it
  // actually slides across the eye.

  // Smiling raises the lower lid (a real smile reaches the eyes).
  if (w.mouthSmile > 0.05) {
    for (let e = 0; e < 2; e++) {
      const lift = w.mouthSmile * 0.12;
      const top = Math.min(...UPPER_LIDS[e].map((i) => pts[i].y));
      for (const i of LOWER_LIDS[e]) pts[i].y -= (pts[i].y - top) * lift;
    }
  }

  // The brows at rest: the inner ends a little raised (browInnerUp), the
  // outer ends not at all. There is no brow pulse. It ran on its own random
  // timer, independent of the blink's, so the two coincided often enough to
  // read as a tic — brows up, then a blink. An involuntary motion that draws
  // attention to itself is worse than none.
  for (const brow of [LEFT_BROW, RIGHT_BROW]) {
    for (let j = 0; j < brow.length; j++) {
      const innerness = 1 - j / (brow.length - 1); // inner moves most
      const rest = 0.06 * innerness; // resting browInnerUp
      pts[brow[j]].y -= fh * 0.035 * rest;
    }
  }

  f.mouthExtension?.deform?.(pts, mesh.basePoints, f.rig, w);

  // The lower face, for every driver: the chin and the jaw line hinge
  // with the lower lip wherever the driver left them behind (the classic
  // field always did; a photographed pose whose chin lags its lip), and
  // the cheeks follow the jaw and the lip shapes. After the driver, so it
  // reads what the lip actually did, jaw range and all.
  if (f.lowerFace) applyLowerFace(pts, mesh.basePoints, f.lowerFace, w, tuning.mouthOpen);

  // Derived midpoint vertices (mouth subdivision) follow their parents
  // through EVERY layer above — computed last, from final positions.
  for (const [a, b] of mesh.derivedParents) {
    pts.push({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
  }
  // The neck band follows the jaw line by each vertex's share.
  for (const v of mesh.neckBand) {
    const p = pts[v.parent], b = mesh.basePoints[v.parent];
    pts.push({ x: v.base.x + (p.x - b.x) * v.share, y: v.base.y + (p.y - b.y) * v.share });
  }

  return pts;
}

/** The mouth's centroid and size at rest, canvas px. */
interface MouthBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Mouth geometry in canvas space, from the rig's mouth points. */
function mouthBox(pts: readonly Point[], mouthIdx: readonly number[]): MouthBox {
  let mcx = 0;
  let mcy = 0;
  let mMinX = Infinity, mMaxX = -Infinity, mMinY = Infinity, mMaxY = -Infinity;
  for (const i of mouthIdx) {
    mcx += pts[i].x;
    mcy += pts[i].y;
    mMinX = Math.min(mMinX, pts[i].x);
    mMaxX = Math.max(mMaxX, pts[i].x);
    mMinY = Math.min(mMinY, pts[i].y);
    mMaxY = Math.max(mMaxY, pts[i].y);
  }
  mcx /= mouthIdx.length;
  mcy /= mouthIdx.length;
  return { cx: mcx, cy: mcy, w: Math.max(mMaxX - mMinX, 1), h: Math.max(mMaxY - mMinY, 1) };
}

/**
 * The classic mouth: blendshape-driven deformation as a CONTINUOUS FIELD
 * over every vertex, not a binary mouth/not-mouth split. The split moved
 * lip landmarks far while their neighbours stayed put, which tore the
 * texture into visible stair-steps below the lip.
 */
function classicMouth(
  pts: Point[],
  mouth: MouthBox,
  innerRing: readonly number[],
  w: BlendWeights,
  mouthOpen: number
): void {
  const { cx: mcx, cy: mcy, w: mw, h: mh } = mouth;
  const innerSet = new Set(innerRing);

  const reach = mw * 1.15; // how far mouth motion bleeds into the face
  // Rounded shapes open a narrower lens: at full pucker the drop reaches
  // ~75% of the way to the corners. Narrower (0.65 was tried) turns a
  // wide flat lip — every cartoon — into a pointed teardrop on "oh".
  const lensWidth = 1.05 - 0.3 * Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
  for (let i = 0; i < pts.length; i++) {
    // The eyes, brows, nose and forehead are no part of a mouth: the
    // field's reach used to lift the nose tip a little on every open vowel.
    if (UPPER_FACE.has(i)) continue;
    const px = pts[i].x - mcx;
    const py = pts[i].y - mcy;
    const dist = Math.hypot(px, py * 1.35); // squashed: motion spreads wider than tall
    if (dist > reach) continue;
    // Smoothstep falloff: 1 at the lips, easing to 0 at `reach`.
    const t = 1 - dist / reach;
    const falloff = t * t * (3 - 2 * t);
    const nx = px / (mw / 2);
    const ny = py / (mh / 2);
    let dx = 0;
    let dy = 0;
    // jawOpen: the jaw is a HINGE. Everything below the lip seam drops as
    // one unit — the lower lip keeps its thickness and travels with the
    // chin. The previous field scaled the drop with distance below the
    // mouth centre, which is a gradient, not a hinge: the lower lip's top
    // edge moved a little and its bottom edge a lot, so on every open
    // vowel the lip stretched to twice its height while the painted
    // opening stayed a thin lens. Measured on a photograph at jawOpen
    // 0.85: lip band 2.1x its resting height. A short ramp just below the
    // seam takes the drop from 0 to full, so the seam itself parts
    // cleanly instead of tearing.
    // Assigned by IDENTITY, not by height: with the mouth closed the upper
    // and lower inner-lip landmarks sit at the same y (measured: 0.05 vs
    // 0.08 half-heights), so any ramp on y drags the upper lip down with
    // the lower and the two never separate. Lower-lip landmarks drop as a
    // unit (tapering into the anchored corners); upper-lip landmarks
    // stay; skin takes a ramp by height.
    const hinge = hingeShare(i, nx, ny, lensWidth);
    dy += w.jawOpen * mh * JAW_DROP * hinge * falloff;
    if (ny < 0) dy -= w.jawOpen * mh * 0.08 * -ny * falloff;
    // pucker/funnel: narrow horizontally, round the aperture.
    dx -= (w.mouthPucker * 0.32 + w.mouthFunnel * 0.18) * nx * (mw / 2) * falloff;
    dy += (ny < 0 ? -w.mouthFunnel * 0.14 : w.mouthFunnel * 0.1) * mh * falloff;
    // stretch/smile: widen, corners up and out.
    dx += (w.mouthStretch * 0.26 + w.mouthSmile * 0.16) * nx * (mw / 2) * falloff;
    if (Math.abs(nx) > 0.55) {
      dy -= w.mouthSmile * mh * 0.3 * (Math.abs(nx) - 0.55) * falloff;
    }
    if (innerSet.has(i)) {
      // NOTE: no extra "part the inner ring" term here. It fired only on
      // landmarks below the mouth centroid, so it opened some of the ring
      // and not the rest — the seam came out as a zigzag. The aperture is
      // synthesised in the classic mouth's interior instead
      // (paint-classic-mouth.ts), which needs this ring to stay a clean
      // curve.
      dy += (mcy - pts[i].y) * w.mouthClose * 0.8;
    }
    pts[i].x += dx * mouthOpen;
    pts[i].y += dy * mouthOpen;
  }
}

/**
 * Eased blinks: the upper lid sweeps DOWN to the lower lid (lid skin
 * stretches over the eyeball); the lower lid rises only slightly.
 * Corner points stay pinned, mid-lid points travel furthest. `amount` is
 * how far, `strength` the tuning's blink.
 */
function blinkLids(pts: Point[], amount: number, strength: number): void {
  for (let e = 0; e < 2; e++) {
    const [c0, c1] = EYE_CORNERS[e];
    const ecx = (pts[c0].x + pts[c1].x) / 2;
    const halfW = Math.max(Math.abs(pts[c1].x - pts[c0].x) / 2, 1);
    let eyeBottom = -Infinity;
    let eyeTop = Infinity;
    for (const i of LOWER_LIDS[e]) eyeBottom = Math.max(eyeBottom, pts[i].y);
    for (const i of UPPER_LIDS[e]) eyeTop = Math.min(eyeTop, pts[i].y);
    for (const i of UPPER_LIDS[e]) {
      const centrality = Math.max(0, 1 - ((pts[i].x - ecx) / halfW) ** 2);
      // A PARTIAL sweep, and that limit is the whole design. Driving
      // these vertices all the way to the lower lid compresses the
      // eyeball texture into a band and stretches brow skin across it —
      // a translucent smear with the iris showing through. Stopping
      // short keeps the motion inside the range where the mesh still
      // looks like an eye narrowing.
      pts[i].y +=
        (eyeBottom - pts[i].y) *
        amount *
        LID_VERTEX_SWEEP *
        strength *
        (0.15 + 0.85 * centrality);
    }
    for (const i of LOWER_LIDS[e]) {
      const centrality = Math.max(0, 1 - ((pts[i].x - ecx) / halfW) ** 2);
      pts[i].y -= (pts[i].y - eyeTop) * amount * 0.12 * centrality;
    }
  }
}
