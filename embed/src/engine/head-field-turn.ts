/**
 * The head's field (head-field.ts, a ring of triangles from the face's
 * outline out over the hair and the ears to where the head ends) turned
 * with the face by the turn in depth (head-turn.ts). It lets the outline
 * go: the outline from one cheek over the top to the other turns with the
 * face (what its band of hair can take of it: at most HEAD_STRAIN of the
 * band's width), the outline's harmonic correction (head-outline.ts) takes
 * out only what it does not, and the field's own vertices turn on the
 * skull (an ellipsoid through the outline's depth and the head's
 * silhouette, at the skull centre's depth there), their share falling to 0
 * where the field ends. A sphere turned about its centre keeps its
 * silhouette, and so does the head here: the hair slides over it,
 * compressing on the side the face turns to and opening on the other. The
 * outline's ends below the ears, where the neck band hangs, stay held.
 */
import { apply as applyAffine, type Affine } from "./affine";
import type { FaceMesh, Point } from "./geometry";
import { projectTurn, type HeadPose3D } from "./head-camera";
import { SKULL_CENTRE_CM, type CanonicalFit } from "./head-depth";
import type { HeadField } from "./head-field";
import { area, longest } from "./head-fold";
import { softLimit } from "./head-personality";

/** The most a band of the head's field (outline to its end) is squeezed or
 *  stretched by the outline's travel, as a share of its width. */
const HEAD_STRAIN = 0.3;
/** Where along a spoke the field starts to fade, as a share of the way
 *  from the outline to its end. */
const HEAD_FADE_FROM = 0.5;
/** Along the outline from each of its held ends (below the ears, where the
 *  neck band hangs), IODs, the outline's travel eases in from nothing: a
 *  landmark beside a held one, moving whole, crushed the thin triangles
 *  between them (the temple's, 34-234-127, at a 9 degree turn and a nod). */
const HEAD_END_IOD = 0.6;

/** What the field reports of a frame (head-turn.ts TurnStats). */
export interface FieldReport {
  headMinAreaRatio: number;
  headMaxShift: number;
  headCapped: number;
  headMinShare: number;
}

export class FieldTurn {
  /** Per landmark, the field's spoke it starts (-1: none, or one of the
   *  held ends). */
  private readonly spokeOf: Int32Array;
  /** Per spoke, the most its landmark may travel in the head's frame
   *  (HEAD_STRAIN of the band), px, the share it is given toward the
   *  outline's held ends (HEAD_END_IOD), and this frame's share of the
   *  turn. */
  private readonly spokeCap: Float64Array;
  private readonly spokeGain: Float64Array;
  private readonly spokeShare: Float64Array;
  /** Per field vertex: its depth on the skull, and the share of its turn
   *  it takes (1 near the face, 0 where the field ends). */
  private readonly headDepth: Float64Array;
  private readonly headFall: Float64Array;
  /** The field's triangles, and their rest areas (twice, signed). */
  private readonly headTris: [number, number, number][];
  private readonly headRestArea: Float64Array;
  /** Where the camera puts a vertex, this frame, and each vertex's
   *  shift. */
  private readonly seen: Point = { x: 0, y: 0 };
  private readonly shifts: Float64Array;

  /**
   * The field `head` laid on `mesh`, for a turn about `pivot` seen from
   * `camera` px: each spoke's landmark free to turn (the ends, where the
   * neck band hangs, held), each of its vertices given a depth on the skull
   * and the share of its turn it takes. `depth`: the landmarks' (head-
   * depth.ts); `outline`: the outline's landmarks (head-outline.ts);
   * `minArea`: a triangle smaller than this has no shape to keep.
   */
  constructor(
    private readonly head: HeadField,
    mesh: FaceMesh,
    fit: CanonicalFit,
    depth: Float64Array,
    outline: Int32Array,
    private readonly pivot: { readonly x: number; readonly y: number; readonly z: number },
    private readonly camera: number,
    private readonly minArea: number
  ) {
    const base = mesh.basePoints;
    const n = base.length;
    this.spokeOf = new Int32Array(n).fill(-1);
    const spokes = head.spokes;
    this.spokeCap = new Float64Array(spokes.length);
    this.spokeGain = new Float64Array(spokes.length);
    this.spokeShare = new Float64Array(spokes.length);
    this.headDepth = new Float64Array(head.count);
    this.headFall = new Float64Array(head.count);
    this.shifts = new Float64Array(2 * head.count);
    const onOutline = new Set(outline);
    // How far along the outline each spoke's landmark is from the nearer
    // of its held ends.
    const along = new Float64Array(spokes.length);
    for (let k = 1; k < spokes.length; k++) {
      const a = base[spokes[k - 1].landmark],
        b = base[spokes[k].landmark];
      along[k] = along[k - 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const total = along[spokes.length - 1];
    spokes.forEach((s, k) => {
      this.spokeCap[k] = HEAD_STRAIN * (s.outer - s.r0);
      const t = Math.min(1, Math.min(along[k], total - along[k]) / (HEAD_END_IOD * fit.iod));
      this.spokeGain[k] = t * t * (3 - 2 * t);
      if (k > 0 && k < spokes.length - 1 && onOutline.has(s.landmark)) this.spokeOf[s.landmark] = k;
    });
    const zc = fit.at(SKULL_CENTRE_CM).z;
    head.vertices.forEach((v, j) => {
      const s = spokes[v.spoke];
      // On the skull: an ellipse through the outline's depth and the
      // silhouette, where the depth is the skull centre's.
      const S = Math.max(s.silhouette, s.r0 + 1e-3);
      const room = 1 - (s.r0 / S) ** 2;
      const left = 1 - (v.r / S) ** 2;
      const zo = depth[s.landmark];
      this.headDepth[j] = v.r >= S || room <= 1e-6 ? zc : zc + (zo - zc) * Math.sqrt(Math.min(1, left / room));
      const from = s.r0 + HEAD_FADE_FROM * (s.outer - s.r0);
      const t = Math.max(0, Math.min(1, (v.r - from) / Math.max(1e-6, s.outer - from)));
      this.headFall[j] = 1 - t * t * (3 - 2 * t);
    });
    const rest = (i: number): Point =>
      i < n
        ? base[i]
        : i >= head.first
          ? head.vertices[i - head.first].base
          : i >= n + mesh.derivedParents.length
            ? mesh.neckBand[i - n - mesh.derivedParents.length].base
            : base[0];
    this.headTris = mesh.triangles.slice(head.triangleFrom).map(([a, b, c]) => [a, b, c]);
    this.headRestArea = Float64Array.from(this.headTris, ([a, b, c]) => area(rest(a), rest(b), rest(c)));
  }

  /**
   * The outline's own travel this frame, into `move` (per landmark, x and
   * y): held (where no spoke starts), or, where the head's field turns with
   * the face, as much as the field's band takes (HEAD_STRAIN of its width,
   * eased into past 70% of it: softLimit's knee). `want`: per landmark, the
   * turn's move; `share` gets each outline landmark's share of it.
   */
  outline(outline: Int32Array, want: Float64Array, move: Float64Array, share: Float64Array, report: FieldReport): void {
    for (let k = 0; k < outline.length; k++) {
      const i = outline[k];
      const spoke = this.spokeOf[i];
      if (spoke < 0) {
        share[k] = 0;
        continue;
      }
      const cap = this.spokeCap[spoke],
        gain = this.spokeGain[spoke];
      const m = Math.hypot(want[2 * i], want[2 * i + 1]) * gain;
      const kept = cap <= 0 ? 0 : m > 1e-9 ? softLimit(m, cap) / m : 1;
      const s = kept * gain;
      share[k] = s;
      this.spokeShare[spoke] = s;
      if (kept < 0.95) report.headCapped++;
      report.headMinShare = Math.min(report.headMinShare, kept);
      move[2 * i] = want[2 * i] * s;
      move[2 * i + 1] = want[2 * i + 1] * s;
    }
  }

  /**
   * The field's own vertices this frame, written into `pts` from the
   * field's first (the mesh's order, after the neck band's), or pushed
   * onto it when it ends there: each on the skull, turned by `turn` less
   * the rigid motion (`back` undoes it) by its spoke's share of the turn
   * (what the spoke's landmark kept, the last `outline`), its own share
   * (falling to 0 where the field ends) and `alpha`, the share of the turn
   * the face kept. `turn` null: where they rest.
   */
  place(pts: Point[], turn: HeadPose3D | null, back: Affine | null, alpha: number, report: FieldReport): void {
    const head = this.head;
    const inPlace = pts.length === head.first + head.count;
    const q = this.seen;
    const shifts = this.shifts;
    for (let j = 0; j < head.count; j++) {
      const v = head.vertices[j];
      const p = v.base;
      let x = p.x,
        y = p.y,
        dx = 0,
        dy = 0;
      const k = turn ? this.headFall[j] * this.spokeShare[v.spoke] * alpha : 0;
      if (turn && k > 0) {
        projectTurn(q, p.x, p.y, this.headDepth[j], turn, this.pivot, this.camera);
        if (back) applyAffine(back, q, q);
        x += (q.x - p.x) * k;
        y += (q.y - p.y) * k;
        dx = x - p.x;
        dy = y - p.y;
      }
      shifts[2 * j] = dx;
      shifts[2 * j + 1] = dy;
      if (inPlace) {
        const o = pts[head.first + j];
        o.x = x;
        o.y = y;
      } else pts.push({ x, y });
    }
    report.headMaxShift = longest(shifts, head.count);
    const tris = this.headTris,
      restArea = this.headRestArea;
    let minRatio = Infinity;
    for (let t = 0; t < restArea.length; t++) {
      const was = restArea[t];
      if (Math.abs(was) < this.minArea) continue;
      minRatio = Math.min(minRatio, area(pts[tris[t][0]], pts[tris[t][1]], pts[tris[t][2]]) / was);
    }
    report.headMinAreaRatio = minRatio === Infinity ? 1 : minRatio;
  }
}
