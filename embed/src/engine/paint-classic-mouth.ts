/**
 * The classic mouth, painted over the warped lips: the soft line where
 * closed lips meet, and the interior an open mouth shows (the cavity, the
 * inner lips' shading, two rows of teeth, the tongue). Built for a
 * photograph of a person's lips; a kind profile (kind-profile.ts) changes
 * its constants for a muzzle. A mouth extension (mouth-extension.ts) can
 * take the interior over, drawn into the aperture measured here.
 *
 * Teeth are anatomically fixed-size and hang from the lips; jawOpen grows
 * the dark gap, NOT the teeth.
 */
import type { KindProfile } from "./kind-profile";
import { centralMouthAnchors, type MouthExtension } from "../mouth-extension";
import { DEFAULT_TUNING, type BlendWeights } from "../types";
import type { Point } from "./geometry";
import { measureAperture, type Aperture } from "./mouth-aperture";

/** What one frame of the classic mouth is painted from. */
export interface ClassicMouthFrame {
  /** The deformed mesh, and the same vertices at rest. */
  pts: Point[];
  neutral: readonly Point[];
  weights: BlendWeights;
  lipColour: [number, number, number];
  skinColour: [number, number, number] | null;
  /** The tuning's mouthOpen and teethThreshold. */
  mouthOpen: number;
  teethThreshold: number;
  /** A mouth renderer that draws the interior instead, if any. */
  extension: MouthExtension | undefined;
  /** The viseme sounding now, read only if the extension draws. */
  viseme: () => string;
}

export class ClassicMouth {
  /** The aperture outline the interior was last built on, canvas px: a
   *  probe for the console (`__liveface.classicMouth.lastAperture`). */
  lastAperture: Point[] | null = null;

  /** `innerRing`: the inner-lip ring the interior is built on
   *  (geometry.ts validInnerRing). */
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly profile: KindProfile,
    private readonly innerRing: readonly number[]
  ) {}

  /** The contact line, if the profile has one, then the interior. */
  paint(f: ClassicMouthFrame): void {
    if (this.profile.contactLine) this.drawLipContactLine(f.pts, f.weights);
    this.drawMouthInterior(f);
  }

  /**
   * A soft dark line where the lips meet. Strongest when the mouth is
   * closed (the interior isn't drawn then), fading out as it opens — gives
   * the lips definition that the raw warp lacks.
   */
  private drawLipContactLine(pts: Point[], weights: BlendWeights): void {
    if (this.innerRing.length < 6) return;
    const openness = Math.min(1, weights.jawOpen * 1.3 + weights.mouthFunnel * 0.25);
    const alpha = 0.28 * Math.max(0, 1 - openness / 0.25);
    if (alpha < 0.02) return;

    const ring = this.innerRing.map((i) => pts[i]);
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    // Corner-to-corner midline through the ring, flattened to the lip seam.
    const sorted = [...ring].sort((p, q) => p.x - q.x);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(70, 30, 28, ${alpha})`;
    ctx.lineWidth = Math.max(1, (sorted[sorted.length - 1].x - sorted[0].x) * 0.018);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sorted[0].x, cy + (sorted[0].y - cy) * 0.1);
    for (let i = 1; i < sorted.length; i++) {
      ctx.lineTo(sorted[i].x, cy + (sorted[i].y - cy) * 0.1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Mouth interior, built on the measured lip seam: the aperture
   * (measureAperture), then, clipped to it, the cavity, the inner lips'
   * shading, the teeth and the tongue, and a soft rim round it. A mouth
   * extension draws into the aperture instead.
   *
   * The seam (midline between opposing inner-lip landmarks) carries the
   * real position, curvature and tilt of this mouth. The opening is
   * synthesised on top of it — necessary because in a closed-lip portrait
   * the inner-lip landmarks are coincident, so there is no aperture to
   * scale. Everything is sampled along ONE parameter so x and y always
   * come from the same place on the curve; mixing parameters sheared the
   * aperture into a triangle.
   *
   * Before it, the interior was built from the real lip curve: the two
   * commissures (the furthest-apart pair on the ring), every lip landmark
   * projected onto the corner-to-corner axis, its offset scaled by a taper
   * window zero at both corners, a Catmull-Rom curve through the result.
   * And before that, an invented symmetric lens spanning the full
   * corner-to-corner width, which put sharp dark spikes at the commissures
   * — lips do not separate at the corners.
   */
  private drawMouthInterior(f: ClassicMouthFrame): void {
    if (this.innerRing.length < 8) return;
    const aperture = this.measureAperture(f);
    if (!aperture) return;
    if (f.extension) {
      this.handToExtension(f, f.extension, aperture);
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.clip(aperture.path);
    this.paintCavity(aperture, f.lipColour);
    this.shadeInnerLips(aperture);
    this.paintTeeth(aperture, f.teethThreshold);
    this.paintTongue(aperture);
    ctx.restore();
    this.paintRim(aperture);
  }

  /** Where the lips part this frame (mouth-aperture.ts); records the
   *  outline as `lastAperture`. */
  private measureAperture(f: ClassicMouthFrame): Aperture | null {
    const { outline, aperture } = measureAperture(
      this.innerRing.map((i) => f.pts[i]),
      this.innerRing.map((i) => f.neutral[i]),
      f.weights,
      f.mouthOpen
    );
    if (outline) this.lastAperture = outline;
    return aperture;
  }

  /** A mouth extension draws the interior into the aperture instead. */
  private handToExtension(f: ClassicMouthFrame, extension: MouthExtension, a: Aperture): void {
    const ctx = this.ctx;
    const neutralA = f.neutral[this.innerRing[a.ia]];
    const neutralB = f.neutral[this.innerRing[a.ib]];
    // A smiling/bowed seam is not its corner chord. Seat oral geometry at
    // the measured central seam, otherwise upper incisors disappear above
    // the aperture while the lower row appears to be the upper teeth.
    const [anchorA, anchorB] = centralMouthAnchors(this.innerRing.map(i => f.neutral[i]), neutralA, neutralB);
    ctx.save();
    try {
      extension.draw(ctx, {
        weights: f.weights,
        viseme: f.viseme(),
        upper: a.upper, lower: a.lower, aperture: a.path,
        neutralLeft: anchorA.x <= anchorB.x ? anchorA : anchorB,
        neutralRight: anchorA.x <= anchorB.x ? anchorB : anchorA,
        lipColour: f.lipColour, skinColour: f.skinColour ?? undefined,
        cavityAlpha: a.cavityAlpha, teethAlpha: a.teethAlpha,
      });
    } finally { ctx.restore(); }
  }

  /**
   * The cavity, derived from this face's lips: deepest at the top where
   * the upper lip shadows it, warming toward the tongue below. Never fully
   * black — a real mouth is a lit red space, not a void, and pure black
   * reads as a hole cut in the face.
   */
  private paintCavity(a: Aperture, lipColour: [number, number, number]): void {
    const ctx = this.ctx;
    ctx.globalAlpha = a.cavityAlpha;
    const cavity = ctx.createLinearGradient(0, a.midY - a.bh / 2, 0, a.midY + a.bh / 2);
    const [lr, lg, lb] = lipColour;
    const shade = (k: number) =>
      `rgb(${Math.round(lr * k)}, ${Math.round(lg * k * 0.86)}, ${Math.round(lb * k * 0.86)})`;
    const [top, middle, bottom] = this.profile.cavityShade;
    cavity.addColorStop(0, shade(top));
    cavity.addColorStop(0.55, shade(middle));
    cavity.addColorStop(1, shade(bottom));
    ctx.fillStyle = cavity;
    ctx.fillRect(a.cx - a.bw, a.midY - a.bh, a.bw * 2, a.bh * 2);
  }

  /**
   * Inner-lip depth. Without this the opening reads as a slice cut through
   * the lips. Light comes from above, so the UNDERSIDE of the upper lip is
   * deeply shadowed while the top surface of the lower lip catches a wet
   * highlight.
   */
  private shadeInnerLips(a: Aperture): void {
    const { bh } = a;
    // Upper lip underside: wide soft shadow, then a tighter darker core.
    this.strokeLipEdge(a.upper, bh * 0.3, "rgba(26, 8, 8, 0.38)");
    this.strokeLipEdge(a.upper, bh * 0.13, "rgba(18, 5, 5, 0.42)");
    // Lower lip inner surface: shadow at the very edge, then the wet line.
    this.strokeLipEdge(a.lower, bh * 0.18, "rgba(40, 12, 12, 0.34)");
    this.strokeLipEdge(
      a.lower.map((q) => ({ x: q.x, y: q.y - bh * 0.03 })),
      Math.max(0.7, bh * 0.03),
      "rgba(255, 226, 214, 0.16)"
    );
  }

  /** One stroke along a lip's inner edge. */
  private strokeLipEdge(edge: Point[], width: number, colour: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(edge[0].x, edge[0].y);
    for (let i = 1; i < edge.length; i++) ctx.lineTo(edge[i].x, edge[i].y);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }

  /**
   * Teeth: individual incisors hanging from the upper arch, the lower row
   * riding the lower lip once there is room for it, both dissolving into
   * darkness toward the commissures. Only for a profile with teeth, and
   * only as far as the lips uncover them.
   */
  private paintTeeth(a: Aperture, teethThreshold: number): void {
    const ctx = this.ctx;
    const { bw, bh, cx, midY, teethAlpha } = a;
    const teethGap = 0.06 * (teethThreshold / DEFAULT_TUNING.teethThreshold);
    // How much of the teeth is exposed. mouthStretch used to appear here
    // twice — once inside `retract`/gapRatio and again as an explicit
    // multiplier — which is why the spread vowels saturated.
    const teethAmount =
      Math.max(
        Math.max(0, Math.min(1, (a.gapRatio - teethGap) / 0.08)),
        a.teethDrive * 0.75
      ) * Math.max(0, Math.min(1, 1 - a.rounding / 0.45));
    ctx.globalAlpha = 1;
    if (!(this.profile.teeth && teethAmount > 0.02 && teethAlpha > 0.02)) return;
    const upperH = Math.min(bh * 0.3, bw * 0.04) * (0.45 + 0.55 * teethAmount);
    this.drawTeethRow(a.upper, bw, teethAlpha, teethAmount, upperH, false);
    // The lower incisors are attached to the JAW, so they ride the lower
    // lip. Almost all of each tooth is hidden behind that lip — only the
    // biting tips clear it — so the row is seated ON the lower edge and
    // drawn short. Floating it into the middle of the cavity (which is
    // what flattening it toward the chord did) looks badly wrong.
    const lowerArch = a.lower.map((q) => ({ x: q.x, y: q.y - bh * 0.055 }));
    // Lower teeth appear once there is room for them without meeting the
    // uppers — a real jaw shows them well before it is fully open.
    const room = bh - upperH * 1.35;
    const lowerH = Math.min(upperH * 0.5, room * 0.34);
    if (lowerH > 0.8) {
      // The lower row shows across the front only.
      this.drawTeethRow(lowerArch, bw, teethAlpha, teethAmount, lowerH, true, 0.3, 0.7, 0.18);
    }
    // Dissolve both rows into darkness toward the commissures, so the
    // teeth recede into the mouth instead of stopping at a hard end.
    const fade = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    fade.addColorStop(0, "rgba(24, 9, 8, 0.95)");
    fade.addColorStop(0.16, "rgba(24, 9, 8, 0.55)");
    fade.addColorStop(0.34, "rgba(24, 9, 8, 0)");
    fade.addColorStop(0.66, "rgba(24, 9, 8, 0)");
    fade.addColorStop(0.84, "rgba(24, 9, 8, 0.55)");
    fade.addColorStop(1, "rgba(24, 9, 8, 0.95)");
    ctx.globalAlpha = teethAlpha;
    ctx.fillStyle = fade;
    ctx.fillRect(cx - bw / 2, midY - bh, bw, bh * 2);
    ctx.globalAlpha = 1;
  }

  /** Tongue: a soft rise low in the cavity on genuinely open shapes. */
  private paintTongue(a: Aperture): void {
    const ctx = this.ctx;
    const { bw, bh, cx, midY } = a;
    ctx.globalAlpha = a.cavityAlpha;
    if (!(a.gapRatio > this.profile.tongueFrom)) return;
    const amount = Math.min(1, (a.gapRatio - this.profile.tongueFrom) / 0.12);
    const ty2 = midY + bh * 0.34;
    const tongue = ctx.createRadialGradient(cx, ty2, bh * 0.06, cx, ty2, bh * 0.6);
    tongue.addColorStop(0, `rgba(176, 92, 86, ${(0.85 * amount).toFixed(3)})`);
    tongue.addColorStop(1, "rgba(120, 52, 48, 0)");
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.ellipse(cx, ty2, bw * 0.3, bh * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Soft rim so the opening blends into the lips. */
  private paintRim(a: Aperture): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = a.cavityAlpha * 0.45;
    ctx.strokeStyle = "rgba(60, 22, 20, 0.5)";
    ctx.lineWidth = Math.max(1, a.bw * 0.016);
    ctx.stroke(a.path);
    ctx.restore();
  }

  /**
   * One row of teeth on a smoothed dental arch, drawn with perspective:
   * the arch curves away from the camera, so teeth toward the corners are
   * narrower, shorter, set deeper into the mouth and in shadow. Uniform
   * teeth read as a flat printed strip.
   */
  private drawTeethRow(
    arch: Point[],
    bw: number,
    alpha: number,
    exposure: number,
    height: number,
    isLower: boolean,
    // Teeth occupy only the front of the arch; the rest curves away out of
    // sight. Without this the row wrapped up around the commissures.
    spanStart = 0.08,
    spanEnd = 0.92,
    // A dental arch is far flatter than the lip opening it sits behind;
    // following the aperture curve exactly made the row dive at the sides.
    flatten = 0.3
  ): void {
    const ctx = this.ctx;
    if (arch.length < 4 || height < 0.6) return;

    // Smooth arch: a quadratic through the ends and the midpoint. Following
    // the raw samples put the teeth on a wavy line.
    // Fit the arch over the span the row actually occupies. Using
    // arch[0] / arch[last] anchored the curve on the ZERO-GAP commissure
    // samples — those sit on the seam, not on the lip, so the fitted arch
    // was pulled up off the lower lip and the row appeared to float.
    const sampleArch = (frac: number) => {
      const f = Math.max(0, Math.min(1, frac)) * (arch.length - 1);
      const i = Math.min(arch.length - 2, Math.floor(f));
      const k = f - i;
      return {
        x: arch[i].x + (arch[i + 1].x - arch[i].x) * k,
        y: arch[i].y + (arch[i + 1].y - arch[i].y) * k,
      };
    };
    const a0 = sampleArch(spanStart);
    const a1 = sampleArch(spanEnd);
    const rawMid = sampleArch((spanStart + spanEnd) / 2);
    const chordMid = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    const am = {
      x: rawMid.x + (chordMid.x - rawMid.x) * flatten,
      y: rawMid.y + (chordMid.y - rawMid.y) * flatten,
    };
    const ctrl = { x: 2 * am.x - (a0.x + a1.x) / 2, y: 2 * am.y - (a0.y + a1.y) / 2 };
    const archAt = (u: number) => {
      const k = Math.max(0, Math.min(1, u));
      const m = 1 - k;
      return {
        x: m * m * a0.x + 2 * m * k * ctrl.x + k * k * a1.x,
        y: m * m * a0.y + 2 * m * k * ctrl.y + k * k * a1.y,
      };
    };

    // Central incisors widest, narrowing to the canines.
    const widths = isLower
      ? [0.45, 0.65, 0.85, 1.0, 1.0, 0.85, 0.65, 0.45]
      : [0.42, 0.62, 0.85, 1.1, 1.1, 0.85, 0.62, 0.42];
    const total = widths.reduce((s, v) => s + v, 0);
    const dir = isLower ? -1 : 1; // lower teeth grow upward

    ctx.save();
    ctx.globalAlpha = Math.min(0.97, alpha * (0.72 + 0.28 * exposure));
    let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      const u0 = acc / total;
      acc += widths[i];
      const u1 = acc / total;
      const uc = (u0 + u1) / 2;
      // Perspective: 1 at the front of the arch, 0 at the corners.
      const depth = Math.sin(Math.PI * uc);
      const h = height * (0.22 + 0.78 * depth);
      // Receding teeth sit deeper — pushed back toward the gum line.
      const recess = (1 - depth) * height * 0.95 * dir;
      const gapPx = Math.max(0.25, bw * 0.0018);

      const a = archAt(u0);
      const b = archAt(u1);
      const mid = archAt(uc);
      const ay = a.y + recess;
      const by = b.y + recess;
      const my = mid.y + recess;

      ctx.beginPath();
      ctx.moveTo(a.x + gapPx, ay);
      ctx.quadraticCurveTo(mid.x, my - 0.1 * h * dir, b.x - gapPx, by);
      ctx.lineTo(b.x - gapPx, by + h * 0.72 * dir);
      ctx.quadraticCurveTo(
        mid.x,
        my + h * 1.1 * dir,
        a.x + gapPx,
        ay + h * 0.72 * dir
      );
      ctx.closePath();

      // Darker toward the corners (in shadow) and darker overall on the
      // lower row, which sits under the upper lip's shadow.
      const tint = (isLower ? 0.42 : 0.5) + (isLower ? 0.36 : 0.5) * depth;
      const g = ctx.createLinearGradient(0, my, 0, my + h * dir);
      g.addColorStop(0, `rgba(${Math.round(236 * tint)}, ${Math.round(230 * tint)}, ${Math.round(216 * tint)}, 0.98)`);
      g.addColorStop(0.7, `rgba(${Math.round(248 * tint)}, ${Math.round(242 * tint)}, ${Math.round(228 * tint)}, 0.97)`);
      g.addColorStop(1, `rgba(${Math.round(200 * tint)}, ${Math.round(192 * tint)}, ${Math.round(176 * tint)}, 0.8)`);
      ctx.fillStyle = g;
      ctx.fill();
      // Hairline separation, as shadow rather than a cut.
      ctx.strokeStyle = "rgba(96, 74, 62, 0.2)";
      ctx.lineWidth = Math.max(0.4, bw * 0.0025);
      ctx.stroke();
    }

    // Shadow where the row meets the lip/gum.
    const first = archAt(0);
    const last = archAt(1);
    const y0 = isLower
      ? Math.max(first.y, last.y) - height * 0.1
      : Math.min(first.y, last.y) - height * 0.25;
    const shade = ctx.createLinearGradient(0, y0, 0, y0 + height * 0.7 * dir);
    shade.addColorStop(0, "rgba(70, 26, 24, 0.5)");
    shade.addColorStop(1, "rgba(70, 26, 24, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(
      Math.min(first.x, last.x),
      Math.min(y0, y0 + height * 0.7 * dir),
      Math.abs(last.x - first.x),
      height * 0.7
    );
    ctx.restore();
  }
}
