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
import type { KindProfile } from "../kind-profile";
import { centralMouthAnchors, type MouthExtension } from "../mouth-extension";
import { DEFAULT_TUNING, type BlendWeights } from "../types";
import type { Point } from "./geometry";

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

/**
 * Smooth closed curve through an ordered loop of points (Catmull-Rom
 * converted to cubic beziers). Straight segments between landmarks make a
 * mouth outline look faceted; this keeps it continuous.
 */
function smoothClosedPath(points: { x: number; y: number }[]): Path2D {
  const path = new Path2D();
  const n = points.length;
  if (n < 3) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y
    );
  }
  path.closePath();
  return path;
}

/** Least-squares quadratic c0 + c1 t + c2 t² through (ts, values). */
function fitQuadratic(values: number[], ts: number[]): number[] {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    b0 += values[i];
    b1 += values[i] * t;
    b2 += values[i] * t2;
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const det =
    s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return [values[0] ?? 0, 0, 0];
  const c0 =
    (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - b2 * s3) + s2 * (b1 * s3 - b2 * s2)) / det;
  const c1 =
    (s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - s2 * b1)) / det;
  const c2 =
    (s0 * (s2 * b2 - s3 * b1) - s1 * (s1 * b2 - s2 * b1) + b0 * (s1 * s3 - s2 * s2)) / det;
  return [c0, c1, c2];
}

/** The quadratic `c` at `t`. */
const evalQuadratic = (c: number[], t: number) => c[0] + c[1] * t + c[2] * t * t;

// --- The aperture: where the lips part, measured -----------------------------

/** The mouth's corner-to-corner axis on the inner ring. */
interface MouthAxis {
  /** The commissures' positions on the ring, and the commissures. */
  ia: number;
  ib: number;
  left: Point;
  right: Point;
  /** left -> right, its length and its length squared. */
  ax: number;
  ay: number;
  len: number;
  len2: number;
  /** The unit normal to the axis pointing down the screen: the way a mouth
   *  opens. */
  nx: number;
  ny: number;
}

/**
 * The commissures (the ring's furthest-apart pair) and the axis between
 * them. Null for a mouth under 4 px wide.
 */
function mouthAxis(ring: readonly Point[]): MouthAxis | null {
  const n = ring.length;
  let ia = 0;
  let ib = 1;
  let best = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d2 = (ring[i].x - ring[j].x) ** 2 + (ring[i].y - ring[j].y) ** 2;
      if (d2 > best) {
        best = d2;
        ia = i;
        ib = j;
      }
    }
  }
  const left = ring[ia].x <= ring[ib].x ? ring[ia] : ring[ib];
  const right = ring[ia].x <= ring[ib].x ? ring[ib] : ring[ia];
  const ax = right.x - left.x;
  const ay = right.y - left.y;
  const len = Math.hypot(ax, ay);
  if (len < 4) return null;
  // Stable opening direction: perpendicular to the corner-to-corner axis,
  // pointing down the screen.
  let nx = -ay / len;
  let ny = ax / len;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { ia, ib, left, right, ax, ay, len, len2: len * len, nx, ny };
}

/** Where along the axis `q` projects, 0 at the left corner, 1 at the right. */
const alongAxis = (axis: MouthAxis, q: Point) =>
  Math.max(0, Math.min(1, ((q.x - axis.left.x) * axis.ax + (q.y - axis.left.y) * axis.ay) / axis.len2));

/** What the weights ask of the opening, before the mesh is measured. */
interface OpeningDrive {
  /** How round the shape is, 0..1. */
  rounding: number;
  /** How far the teeth show without the jaw dropping: retraction or the
   *  labiodental tuck. */
  teethDrive: number;
  /** The synthetic opening's height, canvas px. */
  synthHeight: number;
}

function openingDrive(w: BlendWeights, axisLen: number, mouthOpen: number): OpeningDrive {
  const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
  const openFrac =
    w.jawOpen * 0.23 + w.mouthFunnel * 0.07 + w.mouthStretch * 0.03 - w.mouthClose * 0.05;
  // Lip RETRACTION, which is a different thing from jaw opening. /f/ /v/
  // /s/ /z/ /sh/ barely drop the jaw — measured, /f/'s openFrac is exactly
  // 0.010 against a 0.012 bail, so the whole interior returned early and
  // those sounds rendered as a flat closed line. What they actually show is
  // a bright tooth edge behind pulled-back lips.
  //
  // Rounding suppression is SQUARED: linear let /ou/ (a pucker, which shows
  // nothing) leak through. The stretch deadband stops silence, which has a
  // little residual stretch, from growing teeth.
  const retract =
    Math.min(1, w.mouthStretch * 1.5 + w.mouthSmile * 0.6) *
    (1 - rounding) ** 2 *
    Math.min(1, Math.max(0, (w.mouthStretch - 0.14) / 0.16));
  // The labiodental tuck, /f/ and /v/, is the OTHER way teeth become
  // visible, and it is not retraction — the lower lip rides UP against the
  // upper incisors. For that shape mouthClose is the cause of the teeth
  // showing, not a reason to hide them, which is why gating teeth on
  // `1 - mouthClose` left /f/ at 0.058 alpha, i.e. invisible.
  //
  // mouthStretch is what separates it from a bilabial: /f/ carries ~0.25,
  // /p/ /b/ /m/ carry none, so a closed mouth stays closed.
  const tuck = w.mouthClose * Math.min(1, w.mouthStretch / 0.2) * (1 - rounding);
  const teethDrive = Math.max(retract, tuck);
  // A geometry floor, deliberately well below the cavity's 0.03 knee: /f/
  // gets an arch to hang teeth from, not a black hole.
  const synthHeight =
    Math.max(Math.max(0, openFrac), teethDrive * 0.018) * axisLen * mouthOpen;
  return { rounding, teethDrive, synthHeight };
}

/**
 * The lip seam as a smooth curve: the midline between opposing inner-lip
 * landmarks, parameterised by where it projects on the axis, fitted by a
 * least-squares quadratic in x and in y. Interpolating the raw midpoints
 * put a 16px step at the mouth centre — the central lip landmarks take the
 * strongest jaw displacement, so the midline kinked and the aperture
 * sheared into a hook. A real lip line is a smooth curve, so fit one.
 */
function seamCurve(ring: readonly Point[], axis: MouthAxis): (t: number) => Point {
  const n = ring.length;
  const half = Math.floor(n / 2);
  const { left, right } = axis;
  const seam: { x: number; y: number; t: number }[] = [{ x: left.x, y: left.y, t: 0 }];
  for (let k = 1; k < half; k++) {
    const lo = ring[k];
    const up = ring[n - k];
    const sx = (lo.x + up.x) / 2;
    const sy = (lo.y + up.y) / 2;
    const t = Math.max(
      0,
      Math.min(1, ((sx - left.x) * axis.ax + (sy - left.y) * axis.ay) / axis.len2)
    );
    seam.push({ x: sx, y: sy, t });
  }
  seam.push({ x: right.x, y: right.y, t: 1 });
  seam.sort((p, q) => p.t - q.t);

  const seamTs = seam.map((q) => q.t);
  const fx = fitQuadratic(seam.map((q) => q.x), seamTs);
  const fy = fitQuadratic(seam.map((q) => q.y), seamTs);
  return (t: number) => {
    const tc = Math.max(0, Math.min(1, t));
    return {
      x: fx[0] + fx[1] * tc + fx[2] * tc * tc,
      y: fy[0] + fy[1] * tc + fy[2] * tc * tc,
    };
  };
}

/**
 * The MEASURED parting, as half its height at `t` along the axis. The jaw
 * hinge (deform.ts) moves the whole lower lip, so the inner rings
 * genuinely separate in the mesh and the triangles between them stretch.
 * The painted cavity has to cover exactly that region, or the stretched lip
 * texture shows as a streaked band under a too-small opening (which is
 * what a fixed fraction of mouth width produced once the lip started to
 * move).
 *
 * The upper and lower rings are fitted separately as smooth curves along
 * the mouth axis (the raw ring zigzags; that zigzag is why the aperture
 * was synthesised in the first place), and their separation is taken less
 * the same separation at rest (`rest`, the ring at rest) — a closed mouth's
 * landmarks still sit a few pixels apart, and that must not open a hole in
 * silence. The seam is the midpoint of each pair, so the parting splits
 * equally above and below it.
 */
function measuredParting(ring: readonly Point[], rest: readonly Point[], axis: MouthAxis): (t: number) => number {
  const n = ring.length;
  const half = Math.floor(n / 2);
  const along = (q: Point) => (q.x - axis.left.x) * axis.nx + (q.y - axis.left.y) * axis.ny;
  const fitRing = (points: Point[]) =>
    fitQuadratic(points.map(along), points.map((q) => alongAxis(axis, q)));
  const lowerNow: Point[] = [];
  const upperNow: Point[] = [];
  const lowerRest: Point[] = [];
  const upperRest: Point[] = [];
  for (let k = 1; k < half; k++) {
    lowerNow.push(ring[k]);
    upperNow.push(ring[n - k]);
    lowerRest.push(rest[k]);
    upperRest.push(rest[n - k]);
  }
  // Four fits per frame, not four per sample.
  const fits =
    lowerNow.length >= 3
      ? { ln: fitRing(lowerNow), un: fitRing(upperNow), lr: fitRing(lowerRest), ur: fitRing(upperRest) }
      : null;
  return (t: number): number => {
    if (!fits) return 0;
    const now = evalQuadratic(fits.ln, t) - evalQuadratic(fits.un, t);
    const still = evalQuadratic(fits.lr, t) - evalQuadratic(fits.ur, t);
    return Math.max(0, (now - still) / 2);
  };
}

/**
 * The aperture's upper and lower edges, sampled off the seam along the
 * axis normal: on each side whichever is larger, the mesh's own parting
 * (the stretched triangles that must be covered) or the synthetic profile
 * (retraction and teeth shapes, where the jaw barely moves). Both share
 * their first and last points.
 *
 * The aperture always ends INSIDE the commissures: its own rounded ends
 * then land on lip flesh, so the lips stay joined at the corners even
 * though the profile itself is blunt. With the mesh genuinely parting, the
 * painted opening must reach as far as the parting does — the measured
 * profile closes on its own at the corners. Rounded shapes still narrow
 * the synthetic profile.
 */
function apertureEdges(
  seamAt: (t: number) => Point,
  partingHalfAt: (t: number) => number,
  open: OpeningDrive,
  axis: MouthAxis
): { upper: Point[]; lower: Point[] } {
  const spanHalf = 0.97 / 2;
  const t0 = 0.5 - spanHalf;
  const t1 = 0.5 + spanHalf;
  const synthSpanHalf = (0.84 - open.rounding * 0.4) / 2;

  const SAMPLES = 26;
  const LOWER_SHARE = 0.80; // the jaw drops; the upper lip barely lifts
  const UPPER_SHARE = 0.20;
  const upper: Point[] = [];
  const lower: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const t = t0 + u * (t1 - t0);
    const here = seamAt(t);
    // Offset along the MOUTH AXIS normal, not the local seam normal.
    // The seam comes from noisy landmarks: where it tilts steeply the
    // local normal swings toward horizontal (and the sign-flip guard
    // fires), so the opening sheared into a wedge/hook on one side. A
    // mouth opens perpendicular to its own corner-to-corner axis.
    const nx = axis.nx;
    const ny = axis.ny;
    // Superellipse profile. sin(pi*u)^1.15 leaves the ends with a slope
    // of ~1.9 — almost linear, which is exactly why the mouth read as a
    // TRIANGLE. A true ellipse has an end slope near 20 (blunt); this
    // superellipse keeps that roundness while staying slightly fuller in
    // the middle than a circle.
    const e = Math.abs(2 * u - 1);
    // Synthetic profile lives in its own (narrower, rounding-aware) span.
    const es = Math.min(1, Math.abs(t - 0.5) / synthSpanHalf);
    const gap = open.synthHeight * Math.pow(Math.max(0, 1 - Math.pow(es, 2.4)), 1 / 1.9);
    // The measured parting is already a smooth curve that closes where
    // the rings meet, so it is used almost to the ends: forcing it to zero
    // early left parted mesh triangles near the corners uncovered.
    const parted = partingHalfAt(t) * Math.pow(Math.max(0, 1 - Math.pow(e, 8)), 0.5);
    const lowerOff = Math.max(gap * LOWER_SHARE, parted);
    const upperOff = Math.max(gap * UPPER_SHARE, parted);
    lower.push({ x: here.x + nx * lowerOff, y: here.y + ny * lowerOff });
    upper.push({ x: here.x - nx * upperOff, y: here.y - ny * upperOff });
  }
  return { upper, lower };
}

/** The open mouth this frame, as its interior is painted into it. */
interface Aperture {
  /** The commissures' positions on the inner ring. */
  ia: number;
  ib: number;
  upper: Point[];
  lower: Point[];
  /** The outline, closed and smoothed: the clip everything is painted in. */
  path: Path2D;
  /** The outline's box: width, height, centre. */
  bw: number;
  bh: number;
  cx: number;
  midY: number;
  /** How far open, as a share of the mouth's width. */
  gapRatio: number;
  rounding: number;
  teethDrive: number;
  cavityAlpha: number;
  teethAlpha: number;
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

  /**
   * Where the lips part this frame, and how much of the interior shows;
   * null when the lips are together (or the mouth too small to open).
   * Records the outline as `lastAperture`.
   */
  private measureAperture(f: ClassicMouthFrame): Aperture | null {
    const ring = this.innerRing.map((i) => f.pts[i]);
    const axis = mouthAxis(ring);
    if (!axis) return null;
    const open = openingDrive(f.weights, axis.len, f.mouthOpen);
    const seamAt = seamCurve(ring, axis);
    const partingHalfAt = measuredParting(ring, this.innerRing.map((i) => f.neutral[i]), axis);
    let measuredMax = 0;
    for (let i = 0; i <= 8; i++) measuredMax = Math.max(measuredMax, partingHalfAt(0.2 + (i / 8) * 0.6));
    const openHeight = Math.max(open.synthHeight, measuredMax * 2);
    if (openHeight < axis.len * 0.010) return null; // lips together

    const { upper, lower } = apertureEdges(seamAt, partingHalfAt, open, axis);
    // Drop the shared endpoints: at u=0 and u=1 the gap is zero, so
    // upper and lower hold the SAME point there. Feeding coincident
    // points to Catmull-Rom gives zero-length tangents and the curve
    // overshoots into a hook/wing off the corner of the mouth.
    const outline = [...lower, ...upper.slice(1, -1).reverse()];
    this.lastAperture = outline;

    const xs = outline.map((p) => p.x);
    const ys = outline.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (bw < 2 || bh < 1) return null;
    // Openness must come from the SYNTHESISED opening, not the drawn
    // bounding box: bh also contains this face's resting lip bow, so a
    // curved mouth reported gapRatio > 0.09 with the lips 4px apart and ran
    // the cavity at full opacity. openHeight/axisLen is identity-independent.
    const gapRatio = openHeight / Math.max(1, axis.len);
    // One opacity used to gate the cavity, the lip shading AND the teeth, all
    // keyed purely to how far the jaw had dropped. But teeth visibility is a
    // function of lip retraction, not gape: you see someone's teeth on "fifty"
    // with their jaw almost shut. Two opacities now.
    const cavityAlpha = Math.min(1, Math.max(0, (gapRatio - 0.03) / 0.04));
    const teethAlpha = Math.max(cavityAlpha, Math.min(0.85, open.teethDrive * 0.9));
    if (cavityAlpha <= 0.01 && teethAlpha <= 0.01) return null;
    return {
      ia: axis.ia,
      ib: axis.ib,
      upper,
      lower,
      path: smoothClosedPath(outline),
      bw,
      bh,
      cx: (Math.max(...xs) + Math.min(...xs)) / 2,
      midY: (Math.max(...ys) + Math.min(...ys)) / 2,
      gapRatio,
      rounding: open.rounding,
      teethDrive: open.teethDrive,
      cavityAlpha,
      teethAlpha,
    };
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
