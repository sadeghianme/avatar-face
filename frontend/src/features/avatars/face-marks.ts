/**
 * The marks of one face, as the rig-anchors route returns them and rig-fit
 * takes them back, and the draggable handles they are made of.
 *
 * The scheme follows the avatar's line, and the server decides it: a human
 * mouth is marked by its edges (`mouth`), an animal's or a cartoon's as a
 * line along the lip seam (`mouth_line`) with a `chin`; an animal has no
 * pupils. The panel draws whatever the response contains, so it never has
 * to agree with the server about which line has what.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A region's extremes as FREE 2D points, so a mouth can curve and an eye
 * can tilt. A box forced both corners to the same height.
 *
 * The head also has its outline between the edges: the temples (upper) and
 * the jaw corners (lower), image left and right. Four edges drew it as a
 * diamond; eight points on a smooth curve draw the oval of the face, and
 * the server fits the face's own oval to that curve (anchor_fit). Marks
 * saved before there were diagonals come without them. */
export interface RegionMarks {
  left: Pt;
  right: Pt;
  top: Pt;
  bottom: Pt;
  center?: Pt;
  upper_left?: Pt;
  upper_right?: Pt;
  lower_right?: Pt;
  lower_left?: Pt;
}

/** A pupil is a circle: its center, and one point on its rim for radius. */
export interface PupilMarks {
  center: Pt;
  rim: Pt;
}

export interface FaceMarks {
  head: RegionMarks;
  left_eye: RegionMarks;
  right_eye: RegionMarks;
  mouth?: RegionMarks;
  /** Corner, three points along the seam, corner — image left to right. */
  mouth_line?: Pt[];
  chin?: Pt;
  left_pupil?: PupilMarks;
  right_pupil?: PupilMarks;
}

export type RegionId = "head" | "left_eye" | "right_eye" | "mouth";
export type PupilId = "left_pupil" | "right_pupil";
export type GroupId = RegionId | PupilId | "mouth_line" | "chin";
type Diagonal = "upper_left" | "upper_right" | "lower_right" | "lower_left";
type Edge = "left" | "right" | "top" | "bottom" | "center" | Diagonal;

export const DIAGONALS: readonly Diagonal[] = ["upper_left", "upper_right", "lower_right", "lower_left"];

/** The head's points in order around the face, clockwise on screen from
 * the top: the order its outline is drawn in, the server checks it in
 * (anchor_fit.HEAD_OUTLINE_EDGES), and the keyboard visits its handles. */
export const HEAD_OUTLINE: readonly Edge[] = [
  "top", "upper_right", "right", "lower_right", "bottom", "lower_left", "left", "upper_left",
];

export const GROUP_COLOURS: Record<GroupId, string> = {
  head: "#a78bfa",
  left_eye: "#38bdf8",
  right_eye: "#38bdf8",
  mouth: "#fb7185",
  mouth_line: "#fb7185",
  chin: "#f97316",
  left_pupil: "#fbbf24",
  right_pupil: "#fbbf24",
};

/** i18n key naming each part of the face. */
export const GROUP_LABELS: Record<GroupId, string> = {
  head: "markHead",
  left_eye: "markLeftEye",
  right_eye: "markRightEye",
  mouth: "markMouth",
  mouth_line: "markMouthLine",
  chin: "markChin",
  left_pupil: "markLeftPupil",
  right_pupil: "markRightPupil",
};

const EDGE_LABELS: Record<Edge, string> = {
  left: "markEdgeLeft",
  right: "markEdgeRight",
  top: "markEdgeTop",
  bottom: "markEdgeBottom",
  center: "markEdgeCenter",
  upper_left: "markEdgeUpperLeft",
  upper_right: "markEdgeUpperRight",
  lower_right: "markEdgeLowerRight",
  lower_left: "markEdgeLowerLeft",
};

export interface Handle {
  /** Stable across renders: "head.left", "mouth_line.2", "chin". */
  id: string;
  group: GroupId;
  /** i18n key (and its parameters) for which point of the part this is. */
  label: string;
  labelParams?: Record<string, number>;
  /** Drawn larger: the point that moves its whole part (a pupil's center). */
  primary?: boolean;
  at(marks: FaceMarks): Pt;
  move(marks: FaceMarks, to: Pt): FaceMarks;
}

function regionHandles(group: RegionId, region: RegionMarks): Handle[] {
  // The head's handles go round its outline, so Tab walks the face's edge;
  // a head saved with four points has only those four.
  const edges: Edge[] =
    group === "head"
      ? HEAD_OUTLINE.filter((edge) => region[edge] !== undefined)
      : ["left", "right", "top", "bottom"];
  if (region.center) edges.push("center");
  return edges.map((edge) => ({
    id: `${group}.${edge}`,
    group,
    label: EDGE_LABELS[edge],
    primary: edge === "center",
    at: (m) => m[group]![edge]!,
    move: (m, to) => ({ ...m, [group]: { ...m[group]!, [edge]: to } }),
  }));
}

function lineHandles(line: Pt[]): Handle[] {
  const last = line.length - 1;
  return line.map((_, i) => ({
    id: `mouth_line.${i}`,
    group: "mouth_line" as const,
    label: i === 0 ? "markLineLeftCorner" : i === last ? "markLineRightCorner" : "markLineSeam",
    labelParams: i === 0 || i === last ? undefined : { n: i, total: last - 1 },
    primary: i === 0 || i === last,
    at: (m) => m.mouth_line![i],
    move: (m, to) => ({ ...m, mouth_line: m.mouth_line!.map((p, k) => (k === i ? to : p)) }),
  }));
}

function pupilHandles(group: PupilId): Handle[] {
  return [
    {
      id: `${group}.center`,
      group,
      label: "markPupilCenter",
      primary: true,
      at: (m) => m[group]!.center,
      // The rim rides along, so moving a pupil keeps its size.
      move: (m, to) => {
        const p = m[group]!;
        const rim = { x: p.rim.x + to.x - p.center.x, y: p.rim.y + to.y - p.center.y };
        return { ...m, [group]: { center: to, rim } };
      },
    },
    {
      id: `${group}.rim`,
      group,
      label: "markPupilRim",
      at: (m) => m[group]!.rim,
      move: (m, to) => ({ ...m, [group]: { ...m[group]!, rim: to } }),
    },
  ];
}

/** Every handle these marks have, in tab order: head, eyes, mouth, chin,
 * pupils. */
export function handlesFor(marks: FaceMarks): Handle[] {
  const handles = [
    ...regionHandles("head", marks.head),
    ...regionHandles("left_eye", marks.left_eye),
    ...regionHandles("right_eye", marks.right_eye),
  ];
  if (marks.mouth) handles.push(...regionHandles("mouth", marks.mouth));
  if (marks.mouth_line) handles.push(...lineHandles(marks.mouth_line));
  if (marks.chin) {
    handles.push({
      id: "chin",
      group: "chin",
      label: "markChinPoint",
      primary: true,
      at: (m) => m.chin!,
      move: (m, to) => ({ ...m, chin: to }),
    });
  }
  for (const pupil of ["left_pupil", "right_pupil"] as const) {
    if (marks[pupil]) handles.push(...pupilHandles(pupil));
  }
  return handles;
}

// Handles closer than this on screen are drawn as one dot (a chin opens on
// the head's bottom edge: both are landmark 152).
const STACKED_PX = 3;

/**
 * The handle a press picks up: the one nearest the pointer within `reach`
 * screen pixels, or null. `scale` is screen pixels per image pixel on each
 * axis. Handles are denser than a fingertip (a mouth line's dots sit about
 * 11px apart on a phone, a pupil's centre inside its eye's handles), so the
 * nearest wins rather than whichever button happens to be painted on top.
 *
 * Handles on one spot can only be told apart by pressing again: a press on
 * the spot where `current` (the handle last picked) sits picks the next
 * handle there.
 */
export function handleAt(
  handles: Handle[],
  marks: FaceMarks,
  at: Pt,
  scale: Pt,
  reach: number,
  current: string | null = null
): Handle | null {
  const apart = (a: Pt, b: Pt) => Math.hypot((a.x - b.x) * scale.x, (a.y - b.y) * scale.y);
  let nearest: Handle | null = null;
  let nearestDistance = reach;
  for (const h of handles) {
    const distance = apart(h.at(marks), at);
    if (distance < nearestDistance) {
      nearest = h;
      nearestDistance = distance;
    }
  }
  if (!nearest) return null;
  const spot = nearest.at(marks);
  const stack = handles.filter((h) => apart(h.at(marks), spot) < STACKED_PX);
  const i = stack.findIndex((h) => h.id === current);
  return i >= 0 ? stack[(i + 1) % stack.length] : nearest;
}

export function clampToImage(p: Pt, width: number, height: number): Pt {
  return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) };
}

// --- The head's outline -------------------------------------------------------------

// A chin this close to the head's bottom edge, as a share of the head's
// height, is the same mark (anchor_fit.CHIN_MERGE).
const CHIN_MERGE = 0.01;

/**
 * The head's outline as the fit lays the face's edge on it: the marked
 * points in outline order (eight, or the four edges of a head saved before
 * the diagonals), with a `chin` marked apart from the head's bottom edge in
 * that edge's place. The face ends at the jaw; the bottom edge then only
 * bounds the head (a dog's ruff hangs below its jaw), as on the server.
 */
export function headOutline(head: RegionMarks, chin?: Pt): Pt[] {
  const height = Math.max(Math.abs(head.bottom.y - head.top.y), 1);
  const distinctChin =
    chin !== undefined && Math.hypot(chin.x - head.bottom.x, chin.y - head.bottom.y) > CHIN_MERGE * height;
  return HEAD_OUTLINE.map((edge) => (edge === "bottom" && distinctChin ? chin : head[edge])).filter(
    (p): p is Pt => p !== undefined
  );
}

/**
 * The uniform Catmull-Rom curve from p1 to p2, at t in [0, 1]. The server
 * fits the face's oval to exactly this curve (anchor_fit.catmull_rom), so
 * the outline drawn here is the edge the mesh will have.
 */
export function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  const at = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) };
}

/**
 * An SVG path for the smooth closed curve through `points`: each span a
 * Catmull-Rom segment, written as the cubic Bezier it is equal to (control
 * points a sixth of the neighbours' chord along), so the browser draws the
 * very curve `catmullRom` describes. Round and still the face: it passes
 * through every mark rather than approximating them.
 */
export function closedCurvePath(points: Pt[]): string {
  const n = points.length;
  if (n < 3) return "";
  const at = (i: number) => points[((i % n) + n) % n];
  const f = (v: number) => Number(v.toFixed(2));
  let d = `M${f(at(0).x)},${f(at(0).y)}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return `${d}Z`;
}

const samePoint = (a?: Pt, b?: Pt) => a?.x === b?.x && a?.y === b?.y;

/**
 * What the avatar's marking panel sends for the head. A head the owner did
 * not touch goes without its diagonals: the server keeps the saved ones, or
 * — for a head saved before there were any, whose diagonals only open where
 * its fit put them — leaves them to the warp, so saving it changes nothing.
 * Once any head point moves, all eight are the owner's and all are sent.
 */
export function marksToSend(marks: FaceMarks, opened: FaceMarks): FaceMarks {
  const head = marks.head;
  const untouched = (Object.keys({ ...head, ...opened.head }) as Edge[]).every((edge) =>
    samePoint(head[edge], opened.head[edge])
  );
  if (!untouched) return marks;
  const edgesOnly = { ...head };
  for (const d of DIAGONALS) delete edgesOnly[d];
  return { ...marks, head: edgesOnly };
}

/** What rig-fit refuses a fit for; see services/anchor_fit.validate. */
export interface FitReason {
  code: string;
  detail: string;
  count?: number | null;
}

/** i18n key per validator code; an unknown code falls back to its prose. */
export const FIT_REASON_LABELS: Record<string, string> = {
  folded_mesh: "fitFolded",
  lids_inverted: "fitLidsInverted",
  eyes_out_of_order: "fitEyesOrder",
  mouth_reversed: "fitMouthReversed",
  outside_head: "fitOutsideHead",
  outline_crossed: "fitOutlineCrossed",
  outline_out_of_order: "fitOutlineOrder",
  pupil_outside_eye: "fitPupilOutsideEye",
};
