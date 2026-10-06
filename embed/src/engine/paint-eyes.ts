/**
 * The eyes, painted over the warped mesh: the gaze (the photograph's own
 * eye slid inside the lids), the lash line riding a mesh blink, and the
 * painted lid of a profile that blinks that way (blink-lid.ts).
 */
import { blinkEase } from "./blink";
import { lidAmount, paintLid, type Blit } from "./blink-lid";
import type { Point } from "./geometry";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS, eyeShape } from "./landmarks";
import type { FaceSamples } from "./sampling";

/** Where an eye's pixels come from: the texture, and its landmarks in it. */
export interface EyeSource {
  texture: HTMLImageElement;
  texPoints: readonly Point[];
}

/**
 * Gaze, by sliding the photograph's own eye inside the lids.
 *
 * The predecessor of this method re-stamped an extracted iris disc, and
 * every version broke on some real avatar: a 10-texture-px iris upscaled
 * into a flat grey disc, and painted eyes got their catchlight stamped
 * twice. The rule that survives arbitrary uploads is: never invent eye
 * pixels.
 *
 * So nothing is synthesised here. The texture region around the iris —
 * iris, catchlight, surrounding sclera, whatever the artist drew — is
 * redrawn as one piece, offset by the gaze, clipped to the intersection
 * of TWO detectors: the eye opening built from the deformed lid points,
 * and a circle around MediaPipe's iris ring. The circle is what makes
 * this survive painted eyes: the clip-vs-original seam lands in sclera
 * (white meeting white) instead of on the eyeliner and lashes, where the
 * lid-polygon-only version doubled the lash line. One copy, so there is
 * exactly one iris and one catchlight; the lid clip follows blinks; the
 * shift is capped well inside the circle so the iris never crosses it.
 */
export function drawGaze(ctx: CanvasRenderingContext2D, pts: Point[], src: EyeSource, gaze: Point): void {
  const gx = Math.max(-0.6, Math.min(0.6, gaze.x));
  const gy = Math.max(-0.5, Math.min(0.5, gaze.y));
  if (Math.abs(gx) < 0.02 && Math.abs(gy) < 0.02) return;

  // Shift scale is capped against the interocular distance, not just the
  // eye's own width: stylised faces (anime) have eyes near half the face
  // wide, and an eye-width-proportional shift slides those giant irises
  // several px — enough to tear against the lashes at the clip boundary.
  const eL0 = pts[EYE_CORNERS[0][0]],
    eL1 = pts[EYE_CORNERS[0][1]];
  const eR0 = pts[EYE_CORNERS[1][0]],
    eR1 = pts[EYE_CORNERS[1][1]];
  const interOc =
    eL0 && eL1 && eR0 && eR1 ? Math.hypot((eR0.x + eR1.x - eL0.x - eL1.x) / 2, (eR0.y + eR1.y - eL0.y - eL1.y) / 2) : 0;

  for (let e = 0; e < 2; e++) {
    const [c0, c1] = EYE_CORNERS[e];
    const a = pts[c0],
      b = pts[c1];
    const ta = src.texPoints[c0],
      tb = src.texPoints[c1];
    if (!a || !b || !ta || !tb) continue;
    const eyeW = Math.hypot(b.x - a.x, b.y - a.y);
    if (eyeW < 3) continue;

    // The pupil detector: iris center and radius from the ring points.
    const [ic, ring] = IRISES[e];
    const c = pts[ic],
      tc = src.texPoints[ic];
    if (!c || !tc) continue;
    let r = 0;
    for (const i of ring) {
      const q = pts[i];
      if (!q) {
        r = 0;
        break;
      }
      r += Math.hypot(q.x - c.x, q.y - c.y);
    }
    r /= 4;
    if (r < 2) continue;

    // The opening: corner, upper lid, corner, lower lid back. Built from
    // the DEFORMED points, so a blink shrinks the clip and mid-blink the
    // patch only paints below the descended lid.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    for (const i of UPPER_LIDS[e]) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(b.x, b.y);
    for (let j = LOWER_LIDS[e].length - 1; j >= 0; j--) {
      const q = pts[LOWER_LIDS[e][j]];
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.clip();
    // ∩ the iris circle, generous enough to hold the shifted iris plus a
    // sclera margin where the seam can hide.
    const R = r * 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.clip();

    // Shift, capped twice: within the circle (so the iris rim never
    // reaches the clip edge) and against the interocular distance (so a
    // giant stylised iris still moves a believable few pixels).
    const capX = Math.min(r * 0.35, interOc * 0.05);
    const capY = Math.min(r * 0.25, interOc * 0.035);
    const sx = gx * capX,
      sy = gy * capY;

    // Source box around the iris in texture space, mapped through the
    // same texture<->canvas ratio the triangles use so content lands 1:1.
    const eyeWt = Math.hypot(tb.x - ta.x, tb.y - ta.y);
    const k = eyeWt / eyeW; // texture px per canvas px
    const m = R + 3;
    ctx.drawImage(
      src.texture,
      tc.x - m * k,
      tc.y - m * k,
      2 * m * k,
      2 * m * k,
      c.x - m + sx,
      c.y - m + sy,
      2 * m,
      2 * m
    );
    ctx.restore();
  }
}

/**
 * A lash line riding the closing lid, for a mesh blink at `blink`.
 *
 * The mesh alone moves the photographed lashes down with the lid, but as
 * the eye compresses they thin out and lose definition just when the eye
 * most needs an edge. This lays this face's OWN lash colour along the lid's
 * leading edge — sampled, never assumed black, because a fair or stylized
 * face can have brown, auburn or near-white lashes and a black line on
 * those looks pasted on.
 */
export function drawLashes(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  blink: number,
  lashColour: readonly string[]
): void {
  if (blink <= 0) return;
  const phase = blink;
  const amount =
    phase < 0.4 ? Math.sin((phase / 0.4) * (Math.PI / 2)) : Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
  if (amount <= 0.02) return;
  for (let e = 0; e < 2; e++) {
    const lid = UPPER_LIDS[e]
      .map((i) => pts[i])
      .filter(Boolean)
      .slice()
      .sort((a, b) => a.x - b.x);
    if (lid.length < 3) continue;
    const width = Math.max(...lid.map((p) => p.x)) - Math.min(...lid.map((p) => p.x));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(lid[0].x, lid[0].y);
    // Through the lid points as a smooth curve, so the line is an arc
    // rather than a chain of segments.
    for (let i = 1; i < lid.length - 1; i++) {
      const mx = (lid[i].x + lid[i + 1].x) / 2;
      const my = (lid[i].y + lid[i + 1].y) / 2;
      ctx.quadraticCurveTo(lid[i].x, lid[i].y, mx, my);
    }
    ctx.lineTo(lid[lid.length - 1].x, lid[lid.length - 1].y);
    ctx.strokeStyle = lashColour[e];
    ctx.globalAlpha = amount * 0.85;
    ctx.lineWidth = Math.max(1, width * 0.022);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }
}

/** The painted lid of a profile that blinks that way, at `blink`, unless
 *  blinking is tuned off (`strength` 0). */
export function drawPaintedLids(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  src: EyeSource,
  blink: number,
  strength: number,
  samples: FaceSamples
): void {
  if (blink <= 0 || strength <= 0) return;
  const amount = lidAmount(blinkEase(blink));
  const flat = samples.look.flat;
  for (let e = 0; e < 2; e++) {
    const shape = eyeShape(pts, e);
    const extent = samples.lidExtent[e];
    const outline = extent ? extent.map((q) => fromTexture(e, pts, src.texPoints, q)) : null;
    const blit = flat || !samples.lidCloneOk[e] ? null : lidBlit(e, pts, src);
    paintLid(ctx, shape, amount, samples.lidTone[e], samples.lashRgb[e], flat, blit, outline);
  }
}

/** A texture point of an eye, in the canvas the eye is drawn in. The eye
 *  stays where it was drawn (the mesh does not move it for a lid blink),
 *  so canvas and texture differ by a scale and an offset read off its
 *  corners. */
function fromTexture(e: number, pts: Point[], texPoints: readonly Point[], t: Point): Point {
  const [c0, c1] = EYE_CORNERS[e];
  const a = pts[c0],
    b = pts[c1],
    ta = texPoints[c0],
    tb = texPoints[c1];
  if (!a || !b || !ta || !tb) return t;
  const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
  return { x: a.x + (t.x - ta.x) / k, y: a.y + (t.y - ta.y) / k };
}

/**
 * Copies of the picture's own pixels for a painted lid: a canvas rectangle
 * of the face as drawn, from the texture the face is drawn from, by the
 * same corner-to-corner mapping as fromTexture.
 */
function lidBlit(e: number, pts: Point[], src: EyeSource): Blit | null {
  const [c0, c1] = EYE_CORNERS[e];
  const a = pts[c0],
    b = pts[c1],
    ta = src.texPoints[c0],
    tb = src.texPoints[c1];
  if (!a || !b || !ta || !tb) return null;
  const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
  return (c, dst, from) => {
    if (dst.w < 1 || dst.h < 1 || from.w < 1 || from.h < 1) return;
    c.drawImage(
      src.texture,
      ta.x + (from.x - a.x) * k,
      ta.y + (from.y - a.y) * k,
      from.w * k,
      from.h * k,
      dst.x,
      dst.y,
      dst.w,
      dst.h
    );
  };
}
