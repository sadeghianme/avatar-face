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
 * can tilt. A box forced both corners to the same height. */
export interface RegionMarks {
  left: Pt;
  right: Pt;
  top: Pt;
  bottom: Pt;
  center?: Pt;
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
type Edge = "left" | "right" | "top" | "bottom" | "center";

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
  const edges: Edge[] = ["left", "right", "top", "bottom"];
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
  pupil_outside_eye: "fitPupilOutsideEye",
};
