/**
 * Where the classic mouth's lips part this frame (paint-classic-mouth.ts
 * paints into it, or hands it to a mouth extension): the corner-to-corner
 * axis on the inner-lip ring, the seam between the lips as a smooth curve,
 * the parting the mesh really shows against the same ring at rest, the
 * opening the blend weights ask for, and from those the aperture's two
 * edges and its outline. Plain functions of the ring's points.
 */
import type { BlendWeights } from "../types";
import type { Point } from "./geometry";

/**
 * Smooth closed curve through an ordered loop of points (Catmull-Rom
 * converted to cubic beziers). Straight segments between landmarks make a
 * mouth outline look faceted; this keeps it continuous.
 */
export function smoothClosedPath(points: { x: number; y: number }[]): Path2D {
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
export function fitQuadratic(values: number[], ts: number[]): number[] {
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
export const evalQuadratic = (c: number[], t: number) => c[0] + c[1] * t + c[2] * t * t;

// --- The aperture: where the lips part, measured -----------------------------

/** The mouth's corner-to-corner axis on the inner ring. */
export interface MouthAxis {
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
export function mouthAxis(ring: readonly Point[]): MouthAxis | null {
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
export interface OpeningDrive {
  /** How round the shape is, 0..1. */
  rounding: number;
  /** How far the teeth show without the jaw dropping: retraction or the
   *  labiodental tuck. */
  teethDrive: number;
  /** The synthetic opening's height, canvas px. */
  synthHeight: number;
}

export function openingDrive(w: BlendWeights, axisLen: number, mouthOpen: number): OpeningDrive {
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
export function seamCurve(ring: readonly Point[], axis: MouthAxis): (t: number) => Point {
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
export function measuredParting(ring: readonly Point[], rest: readonly Point[], axis: MouthAxis): (t: number) => number {
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
export function apertureEdges(
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
export interface Aperture {
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

/**
 * Where the lips part this frame, and how much of the interior shows:
 * `ring` the inner-lip ring now, `rest` the same ring at rest, `mouthOpen`
 * the owner's setting. `outline` is the aperture's outline whenever one was
 * built (the console's `lastAperture`); `aperture` is null when the lips
 * are together, the mouth is too small to open, or nothing would show.
 */
export function measureAperture(
  ring: readonly Point[],
  rest: readonly Point[],
  weights: BlendWeights,
  mouthOpen: number
): { outline: Point[] | null; aperture: Aperture | null } {
  const axis = mouthAxis(ring);
  if (!axis) return { outline: null, aperture: null };
  const open = openingDrive(weights, axis.len, mouthOpen);
  const seamAt = seamCurve(ring, axis);
  const partingHalfAt = measuredParting(ring, rest, axis);
  let measuredMax = 0;
  for (let i = 0; i <= 8; i++) measuredMax = Math.max(measuredMax, partingHalfAt(0.2 + (i / 8) * 0.6));
  const openHeight = Math.max(open.synthHeight, measuredMax * 2);
  if (openHeight < axis.len * 0.010) return { outline: null, aperture: null }; // lips together

  const { upper, lower } = apertureEdges(seamAt, partingHalfAt, open, axis);
  // Drop the shared endpoints: at u=0 and u=1 the gap is zero, so
  // upper and lower hold the SAME point there. Feeding coincident
  // points to Catmull-Rom gives zero-length tangents and the curve
  // overshoots into a hook/wing off the corner of the mouth.
  const outline = [...lower, ...upper.slice(1, -1).reverse()];

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const bw = Math.max(...xs) - Math.min(...xs);
  const bh = Math.max(...ys) - Math.min(...ys);
  if (bw < 2 || bh < 1) return { outline, aperture: null };
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
  if (cavityAlpha <= 0.01 && teethAlpha <= 0.01) return { outline, aperture: null };
  return {
    outline,
    aperture: {
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
    },
  };
}
