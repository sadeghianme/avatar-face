/** The face's marks, and the ones in progress kept for the tab (see index.ts). */
import type { FaceMarks } from "@/features/avatars/face-marks";

import type { CreationAnchors } from "./types.ts";

export type MarkPart = keyof FaceMarks;

/** The parts whose marks differ from the detected ones: what the owner has
 * placed. Animals confirm each part, so this is their checklist. */
export function movedParts(marks: FaceMarks, detected: FaceMarks, parts: readonly MarkPart[]): MarkPart[] {
  return parts.filter((part) => JSON.stringify(marks[part]) !== JSON.stringify(detected[part]));
}

/**
 * Did the marks open on the face template rather than on a detected face?
 * Then each of them is a guess, and the owner places or confirms every
 * part before anything is built (the server refuses otherwise:
 * services.creations.required_marks). An animal always; a person or a
 * drawing whenever the detector missed.
 */
export function marksAreGuessed(anchors: Pick<CreationAnchors, "detected">, oneClickLine: boolean): boolean {
  return !oneClickLine || !anchors.detected;
}

/** The parts the owner vouches for: moved, or ticked as already right. */
export function confirmedParts(
  parts: readonly MarkPart[],
  moved: readonly MarkPart[],
  ticked: readonly MarkPart[]
): MarkPart[] {
  return parts.filter((part) => moved.includes(part) || ticked.includes(part));
}

/** Only these parts of the marks. What finish sends for guessed marks, so
 * a part the owner never confirmed reaches the server as missing rather
 * than as the template's guess. */
export function pickMarks(marks: FaceMarks, parts: readonly MarkPart[]): Partial<FaceMarks> {
  const picked: Partial<FaceMarks> = {};
  for (const part of parts) {
    if (marks[part] !== undefined) Object.assign(picked, { [part]: marks[part] });
  }
  return picked;
}

// --- Marks in progress ----------------------------------------------------------------

/**
 * Marks the owner has placed but not yet finished with, kept for this tab.
 *
 * Nothing is saved on the server until Finish (preview-rig saves nothing),
 * yet the editor unmounts whenever the owner steps back to check the
 * background, reloads, or waits out a finish a restart then interrupts. An
 * animal's twenty-two hand-placed points must not fall back to the template's
 * guess each time. Keyed by the anchors they were placed on, so marks for
 * an image that has since been reframed or re-detected are never restored.
 */
export interface DraftMarks {
  /** The parts moved from where they were detected; the rest are as detected. */
  marks: Partial<FaceMarks>;
  /** Parts confirmed as already right without being moved. */
  ticked: MarkPart[];
}

/** The part of Web Storage this needs; sessionStorage in the app. */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const DRAFT_MARKS_PREFIX = "liveface.creationMarks.";
const MARK_PARTS: ReadonlySet<string> = new Set([
  "head",
  "left_eye",
  "right_eye",
  "mouth",
  "mouth_line",
  "chin",
  "left_pupil",
  "right_pupil",
]);

export function draftMarksKey(creationId: string, anchorsId: string): string {
  return `${DRAFT_MARKS_PREFIX}${creationId}.${anchorsId}`;
}

// Storage can throw (blocked, full, private mode): every access is best
// effort, and without it the editor simply opens on the detected marks.
export function loadDraftMarks(store: DraftStore | null, creationId: string, anchorsId: string): DraftMarks | null {
  try {
    const raw = store?.getItem(draftMarksKey(creationId, anchorsId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { marks, ticked } = parsed as { marks?: unknown; ticked?: unknown };
    if (!marks || typeof marks !== "object" || Array.isArray(marks)) return null;
    // Only parts this editor knows: a hand-edited or older entry must not
    // put a stray key into what finish sends.
    const known = Object.fromEntries(Object.entries(marks).filter(([part]) => MARK_PARTS.has(part)));
    return {
      marks: known as Partial<FaceMarks>,
      ticked: Array.isArray(ticked) ? (ticked.filter((p) => MARK_PARTS.has(p)) as MarkPart[]) : [],
    };
  } catch {
    return null;
  }
}

/** Keep `draft` for these anchors; null forgets it (back to what was detected). */
export function saveDraftMarks(
  store: DraftStore | null,
  creationId: string,
  anchorsId: string,
  draft: DraftMarks | null
): void {
  try {
    const key = draftMarksKey(creationId, anchorsId);
    if (draft) store?.setItem(key, JSON.stringify(draft));
    else store?.removeItem(key);
  } catch {
    // best effort, see loadDraftMarks
  }
}

/** Forget every draft of a creation: it was finished or deleted. */
export function forgetDraftMarks(store: DraftStore | null, creationId: string): void {
  try {
    if (!store) return;
    const prefix = `${DRAFT_MARKS_PREFIX}${creationId}.`;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // best effort, see loadDraftMarks
  }
}
