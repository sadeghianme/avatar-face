/**
 * A creation: one photo on its way to an avatar, as the creations API
 * returns it, and the rules the wizard reads off it.
 *
 * Everything here is framework-free and has no runtime imports, so the
 * wizard's decisions (which step to open, when to poll, whether the marks
 * still belong to the image) are tested with `node --test` rather than by
 * clicking through the flow. The components only render what these say.
 */
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import type { FaceType } from "@/lib/types";

// --- API shapes -------------------------------------------------------------------

export type StepId = "original" | "framed" | "cutout";

/** A rectangle in fractions of the ORIGINAL upload. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CreationStep {
  id: StepId;
  /** Presigned; a fresh signature on every response (see stabilizeUrls). */
  url: string;
  width: number;
  height: number;
  from: StepId | null;
  crop: CropRect | null;
  roll: number | null;
}

export interface PhotoCheck {
  code: string;
  detail: string;
}

export interface CreationAnalysis {
  image_size: [number, number];
  detector: "mediapipe" | null;
  detected: boolean;
  face_box: [number, number, number, number] | null;
  roll: number | null;
  suggested_face_type: "human" | null;
  suggested_framing: { crop: CropRect; roll: number } | null;
  checks: PhotoCheck[];
}

export interface AnchorValidation {
  ok: boolean;
  reasons: FitReason[];
  warnings: PhotoCheck[];
  detected: boolean;
  one_click: boolean;
}

export interface CreationAnchors {
  id: string;
  /** The step whose pixels the marks are in; null once that image is gone. */
  image: "original" | "framed" | null;
  image_size: [number, number];
  detected: boolean;
  marks: FaceMarks;
  validation: AnchorValidation;
}

export type JobStep = "ingest" | "background" | "detect" | "finish";
export type JobState = "queued" | "running" | "done" | "failed" | "interrupted";

export interface CreationJob {
  id: string;
  step: JobStep;
  state: JobState;
  error: PhotoCheck | null;
  started_at: string;
  progress: { fraction: number; label: string | null } | null;
  retryable: boolean;
}

export type CreationStatus = "draft" | "finishing" | "finished" | "expired";

export interface Creation {
  id: string;
  /** Null until the owner (or the analysis) has said what the face is. */
  face_type: FaceType | null;
  status: CreationStatus;
  revision: number;
  current: StepId | null;
  steps: CreationStep[];
  analysis: CreationAnalysis | null;
  anchors: CreationAnchors | null;
  job: CreationJob | null;
  avatar_id: string | null;
  background_removal: {
    available: boolean;
    reason: null | "face_type_required" | "not_for_face_type" | "segmentation_unavailable";
  };
  created_at: string;
  updated_at: string;
}

export interface PreviewRig {
  rig: unknown;
  reasons: FitReason[];
}

export interface FinishResult {
  avatar_id: string;
  creation: Creation;
}

// --- Upload ---------------------------------------------------------------------

/** The server's limits (services.creations), checked before a byte is sent. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type FileProblem = "model_file" | "unsupported_image_type" | "image_too_large";

/**
 * Why a file cannot start a creation, or null. The server checks again (and
 * decodes, which is where a 100-megapixel photo is refused); this spares a
 * 15 MB upload that was always going to bounce. A .glb gets its own answer:
 * it is a 3D avatar, which has its own importer on the same page.
 */
export function checkFile(file: { name: string; type: string; size: number }): FileProblem | null {
  if (file.name.toLowerCase().endsWith(".glb") || file.type === "model/gltf-binary") {
    return "model_file";
  }
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "unsupported_image_type";
  if (file.size > MAX_UPLOAD_BYTES) return "image_too_large";
  return null;
}

/** "holiday-2024.final.jpg" → "holiday-2024.final": a starting name only. */
export function nameFromFile(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim().slice(0, 128);
}

// --- Steps and jobs ----------------------------------------------------------------

export type WizardStep = "frame" | "background" | "points";
export const WIZARD_STEPS: readonly WizardStep[] = ["frame", "background", "points"];

const ACTIVE: ReadonlySet<JobState> = new Set(["queued", "running"]);

export function isJobActive(job: CreationJob | null | undefined): boolean {
  return Boolean(job && ACTIVE.has(job.state));
}

/** Something is being computed and the creation will change without us:
 * a job, or a finish (which is a job, but also a status). Poll while so. */
export function isBusy(creation: Creation | null | undefined): boolean {
  return Boolean(creation && (isJobActive(creation.job) || creation.status === "finishing"));
}

/**
 * The job's failure worth showing, or null. "superseded" is not one: the
 * owner changed the creation while the job ran, so its result was dropped
 * on purpose and there is nothing to act on.
 */
export function jobFailure(job: CreationJob | null | undefined): PhotoCheck | null {
  if (!job || (job.state !== "failed" && job.state !== "interrupted")) return null;
  const error = job.error ?? { code: job.state === "interrupted" ? "interrupted" : "job_failed", detail: "" };
  return error.code === "superseded" ? null : error;
}

export function stepById(creation: Creation, id: StepId | null | undefined): CreationStep | null {
  return creation.steps.find((step) => step.id === id) ?? null;
}

export function currentStep(creation: Creation): CreationStep | null {
  return stepById(creation, creation.current);
}

/** The image whose pixel grid the current image shares: a cut-out is its
 * source's grid (no pixel moved), every other step its own. Marks placed on
 * one are valid on the other. */
export function frameOf(creation: Creation): StepId | null {
  const current = currentStep(creation);
  if (!current) return null;
  return current.id === "cutout" ? current.from : current.id;
}

/** Do the anchors belong to the image the owner is looking at? Reframing,
 * switching line or choosing another frame clears or strands them. */
export function anchorsCurrent(creation: Creation): boolean {
  const anchors = creation.anchors;
  return Boolean(anchors && anchors.image !== null && anchors.image === frameOf(creation));
}

/** The image background removal applies to: the current one, or the one
 * the current cut-out was made from. */
export function backgroundSource(creation: Creation): CreationStep | null {
  const current = currentStep(creation);
  if (current?.id === "cutout") return stepById(creation, current.from);
  return current;
}

/** The original is stored and the line is known: steps 2 and 3 can open. */
export function pastFirstStep(creation: Creation): boolean {
  return stepById(creation, "original") !== null && creation.face_type !== null;
}

/**
 * The step a creation opens on when the URL does not say (resuming from the
 * avatar list). Wherever work is running, or was last done.
 */
export function inferStep(creation: Creation): WizardStep {
  if (creation.status === "finishing" || creation.status === "finished") return "points";
  if (!pastFirstStep(creation)) return "frame";
  const job = creation.job;
  if (job && (isJobActive(job) || jobFailure(job))) {
    if (job.step === "background") return "background";
    if (job.step === "detect" || job.step === "finish") return "points";
  }
  if (creation.anchors) return "points";
  if (stepById(creation, "cutout")) return "background";
  return "frame";
}

/** The step to show: the one asked for (in the URL) when the creation can
 * be there, else the inferred one. A finishing creation is always on points. */
export function resolveStep(creation: Creation, requested: string | null): WizardStep {
  if (creation.status === "finishing" || creation.status === "finished") return "points";
  const asked = WIZARD_STEPS.find((step) => step === requested);
  if (!asked) return inferStep(creation);
  if (asked !== "frame" && !pastFirstStep(creation)) return "frame";
  return asked;
}

// --- Framing ----------------------------------------------------------------------

export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** The API's bounds on a roll (degrees). */
export const MAX_ROLL = 45;

export interface Framing {
  crop: CropRect;
  roll: number;
}

/** The framing the creation has now: its framed step's, or the whole photo. */
export function appliedFraming(creation: Creation): Framing {
  const framed = stepById(creation, "framed");
  return {
    crop: framed?.crop ?? FULL_FRAME,
    roll: framed?.roll ?? 0,
  };
}

/**
 * The framing step 1 opens with. What was applied, when something was;
 * the analysis' suggestion on a photo nobody has touched since ingest
 * (revision 1: ingest's own write); the whole photo after that, since a
 * creation that moved on unframed was left that way on purpose.
 */
export function initialFraming(creation: Creation): Framing {
  if (stepById(creation, "framed")) return appliedFraming(creation);
  const untouched = creation.revision <= 1 && !creation.anchors && !stepById(creation, "cutout");
  const suggested = creation.analysis?.suggested_framing;
  if (untouched && suggested) return { crop: suggested.crop, roll: suggested.roll };
  return { crop: FULL_FRAME, roll: 0 };
}

// Crops round-trip through the server at 4 decimals; a difference below
// this is the same crop, and re-sending it would drop the cut-out and marks.
const CROP_EPSILON = 5e-4;
const ROLL_EPSILON = 0.05;

export function framingChanged(a: Framing, b: Framing): boolean {
  const keys: (keyof CropRect)[] = ["x", "y", "w", "h"];
  return (
    keys.some((k) => Math.abs(a.crop[k] - b.crop[k]) > CROP_EPSILON) ||
    Math.abs(a.roll - b.roll) > ROLL_EPSILON
  );
}

/**
 * A crop as the API takes it: 4 decimals (what it stores), inside the
 * photo after rounding. A box dragged to the edge can round to x + w of
 * 1.0001, which the server refuses as out of bounds.
 */
export function normalizeCrop(crop: CropRect): CropRect {
  const round = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
  const x = round(crop.x);
  const y = round(crop.y);
  return { x, y, w: Math.min(round(crop.w), round(1 - x)), h: Math.min(round(crop.h), round(1 - y)) };
}

export function clampRoll(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return Math.max(-MAX_ROLL, Math.min(MAX_ROLL, Math.round(degrees * 10) / 10));
}

// --- Polling ----------------------------------------------------------------------

const POLL_FIRST_MS = 600;
const POLL_FACTOR = 1.5;
const POLL_MAX_MS = 5000;

/**
 * Delay before the `attempt`-th poll (0-based) of one job. Ingest and
 * detection are about a second, so the first answers come quickly; a
 * background removal or a queue wait can take a minute, and a tab left
 * open on it should not ask twice a second the whole time.
 */
export function pollDelay(attempt: number): number {
  return Math.min(POLL_MAX_MS, Math.round(POLL_FIRST_MS * POLL_FACTOR ** Math.max(0, attempt)));
}

// --- Stable image URLs --------------------------------------------------------------

export interface HeldUrl {
  url: string;
  at: number;
}

// Presigned URLs live an hour; one is reused for at most this long, so a
// held URL always has most of its life left when something reloads it.
export const URL_REUSE_MS = 15 * 60 * 1000;

const pathOf = (url: string) => url.split("?")[0];

/**
 * The creation with each step's URL replaced by the one already held for
 * the same image, when it is recent enough.
 *
 * Every response signs its URLs afresh, so the same image arrives under a
 * new URL on every poll. The photo would reload, and the talking preview
 * (whose engine restarts when its texture URL changes) would flicker, each
 * time the creation is refetched. Step keys are unique per image, so the
 * path names the image and only the signature is new.
 */
export function stabilizeUrls(
  creation: Creation,
  held: Map<string, HeldUrl>,
  now: number,
  maxAge: number = URL_REUSE_MS
): Creation {
  let changed = false;
  const steps = creation.steps.map((step) => {
    const path = pathOf(step.url);
    const known = held.get(path);
    if (known && now - known.at < maxAge) {
      if (known.url === step.url) return step;
      changed = true;
      return { ...step, url: known.url };
    }
    held.set(path, { url: step.url, at: now });
    return step;
  });
  return changed ? { ...creation, steps } : creation;
}

// --- Marks --------------------------------------------------------------------------

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
 * animal's eighteen hand-placed points must not fall back to the template's
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
  "head", "left_eye", "right_eye", "mouth", "mouth_line", "chin", "left_pupil", "right_pupil",
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

// --- Errors -------------------------------------------------------------------------

/** Codes the wizard has its own words for; anything else shows the
 * server's sentence, which is English but always says something. */
export const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "model_file",
  "unsupported_image_type",
  "image_too_large",
  "unreadable_image",
  "too_many_drafts",
  "too_many_jobs",
  "job_queue_full",
  "creation_not_found",
  "creation_not_ready",
  "creation_not_draft",
  "creation_changed",
  "creation_finishing",
  "crop_out_of_bounds",
  "crop_too_small",
  "face_type_required",
  "background_not_for_face_type",
  "segmentation_unavailable",
  "job_in_progress",
  "unknown_choice",
  "anchors_stale",
  "mark_outside_image",
  "mouth_line_not_for_face_type",
  "marks_required",
  "fit_invalid",
  "nothing_to_retry",
  "upload_gone",
  "interrupted",
  "job_failed",
  "network_error",
]);

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * An error for the owner: our sentence for the code when there is one,
 * the server's otherwise, and when the server said how long to wait
 * (Retry-After on a busy queue), that too.
 */
export function errorText(
  t: Translate,
  code: string,
  detail: string,
  retryAfter: number | null = null
): string {
  const text = KNOWN_ERRORS.has(code) ? t(`createErr_${code}`) : detail || t("error");
  return retryAfter ? `${text} ${t("createRetryAfter", { count: retryAfter })}` : text;
}
