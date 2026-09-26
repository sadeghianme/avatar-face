/**
 * A creation: one photo on its way to an avatar, as the creations API
 * returns it, and the rules the wizard reads off it.
 *
 * Everything here is framework-free and has no runtime imports, so the
 * wizard's decisions (which step to open, when to poll, whether the marks
 * still belong to the image) are tested with `node --test` rather than by
 * clicking through the flow. The components only render what these say.
 */
import type { FaceStatement } from "@/features/avatars/consent";
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import type { FaceType } from "@/lib/types";

// --- API shapes -------------------------------------------------------------------

/** The images of a creation, by opaque id. "adjusted:N" are AI adjust
 * candidates, numbered across rounds (a second round starts after the
 * first's numbers, so an id never names two images); "cutout:N" is the
 * background removed from "adjusted:N", as "cutout" is from the photo. */
export type StepId = "original" | "framed" | "cutout" | `adjusted:${number}` | `cutout:${number}`;

/** A rectangle in fractions of the ORIGINAL upload. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AdjustMode = "touchup" | "stylise" | "regenerate";
export type AdjustStyle = "photoreal" | "illustrated" | "anime" | "render3d";

/** What AI adjust made an "adjusted:N" image from, and how it fared. */
export interface StepAdjust {
  mode: AdjustMode;
  style: AdjustStyle | null;
  model: string;
  /** The photo's eyes were closed and these are the model's invention:
   * the owner must be told, every time the image is shown as a choice. */
  generated_eyes: boolean;
  /** Failed its checks: shown with the reason, never choosable. */
  rejected: PhotoCheck | null;
  checks: { detected?: boolean; fit_ok?: boolean; skin_delta_e?: number };
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
  /** On "adjusted:N" only. */
  adjust?: StepAdjust | null;
  /** On an original the image model made (POST /creations/generate). */
  generated?: { model: string; style: AdjustStyle; provider: "gemini" } | null;
  /** Transparent around the subject: a background removal ("cutout",
   * "cutout:N"), or a touch-up of one (it keeps the cut-out's alpha). */
  cutout?: boolean;
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
  /** The upload's face, measured; null when no face was measured. */
  face_state?: FaceState | null;
  /** What step 3 recommends for the CURRENT image (unlike the rest of the
   * analysis, which describes the upload). Null until the line is known,
   * and on drafts older than per-image checks. */
  recommendation?: Recommendation | null;
}

export interface FaceState {
  eyes_closed: boolean;
  mouth_open: boolean;
  eyes_half_closed?: boolean;
  gaze_off_camera?: boolean;
  teeth_showing?: boolean;
  head_turned?: boolean;
  measures?: {
    eye_aspect: [number, number];
    gaze: number | null;
    mouth_gap: number;
    nose_offset: number;
    yaw: number;
  };
}

export type RecommendedMode = "touchup" | "regenerate" | "none";

export interface Recommendation {
  /** The step it was computed on: the current image when it is fresh. */
  image: StepId;
  mode: RecommendedMode;
  /** Check codes, the regenerate ones first (see REGENERATE_REASONS). */
  reasons: string[];
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
  /** Where the opening marks came from: a detection, the template's guess,
   * or the vision model's points (a pre-fill the owner still confirms).
   * Null on anchors made before this was recorded. */
  source?: "mediapipe" | "template" | "ai" | null;
  /** The step whose pixels the marks are in; null once that image is gone. */
  image: StepId | null;
  image_size: [number, number];
  detected: boolean;
  marks: FaceMarks;
  validation: AnchorValidation;
}

/** A job's step: a creation's, or "mouth_kit", an avatar's mouth made from
 * its photo in the Mouth panel (the same JobOut shape, schemas/job.py). */
export type JobStep = "ingest" | "generate" | "adjust" | "background" | "detect" | "finish" | "mouth_kit";
export type JobState = "queued" | "running" | "done" | "failed" | "interrupted";

/** How far a counted stage is: "3 of 6" mouth shapes settled (made, or
 * given up on for the standard one). */
export interface JobCount {
  done: number;
  total: number;
}

export interface CreationJob {
  id: string;
  step: JobStep;
  state: JobState;
  error: PhotoCheck | null;
  started_at: string;
  /** Live while queued or running, null once the job has ended. `count`
   * belongs to its label only (a new label clears it); absent from a
   * server before it counted anything. */
  progress: { fraction: number; label: string | null; count?: JobCount | null } | null;
  retryable: boolean;
}

export type CreationStatus = "draft" | "finishing" | "finished" | "expired";

export interface AdjustCandidate {
  /** The step holding the image; null when there is none to show (a
   * safety refusal, a provider error, a result with no face in it). */
  step: StepId | null;
  ok: boolean;
  reason: PhotoCheck | null;
  generated_eyes: boolean;
}

export interface AdjustRound {
  mode: AdjustMode;
  style: AdjustStyle | null;
  /** The image the round was made from. */
  source: StepId;
  candidates: AdjustCandidate[];
  /** The monthly image limit stopped the round before every candidate. */
  limit_reached: boolean;
}

/** The creation's AI step: what is offered, what is left, what happened. */
export interface CreationAi {
  /** False when an owner or admin has turned third-party AI off. */
  enabled: boolean;
  /** Adjust modes this line offers (empty until the line is known). */
  modes: AdjustMode[];
  /** The recommended mode, when the current image needs a fix this line
   * offers: pre-selected. Empty when nothing needs fixing, so nothing paid
   * is ever pre-selected on a photo that is fine. */
  suggested: AdjustMode[];
  adjust_rounds_left: number;
  ai_detections_left: number;
  last_round: AdjustRound | null;
  /** A touch-up the wizard starts by itself (see autoAdjustToStart); null
   * otherwise. Absent from a server before it offered one. */
  auto_adjust?: AutoAdjust | null;
}

/** The server's offer of a touch-up nobody has to press for: a person whose
 * parted lips show their teeth (they would stay painted on the lips as the
 * avatar talks), and whose eyes the same touch-up fixes when the check
 * found them wanting too (`reasons`). Once per photo; the owner still
 * chooses the result. */
export interface AutoAdjust {
  mode: "touchup";
  image: StepId;
  reasons: string[];
}

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
  /** The step 2 answer; null until given, and again after a change of
   * line. Choosing an opaque AI result follows "remove" by cutting it out. */
  background?: "remove" | "keep" | null;
  ai: CreationAi;
  /** The uploader's statement finishing needs, recorded for this creation:
   * "depiction" for a person's photo on whatever line it is on now (a
   * stylised photo is still that person), "generated_face" for a face made
   * from words, null for none. Absent from a server before it said so. */
  statement?: FaceStatement | null;
  created_at: string;
  updated_at: string;
}

export interface PreviewRig {
  rig: unknown;
  reasons: FitReason[];
}

/** Something the finished picture still shows around the mouth
 * ("mouth_open", "teeth_showing"): said, not refused. */
export interface FinishWarning {
  code: string;
  detail: string;
}

export interface FinishResult {
  avatar_id: string;
  creation: Creation;
  /** Absent from a server before it said so. */
  warnings?: FinishWarning[];
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

export type WizardStep = "frame" | "background" | "adjust" | "points" | "prepare";
/** 1 Upload + frame, 2 Background, 3 AI adjust, 4 Points, 5 Preparing
 * your avatar: the owner's order (docs/avatar-lines.md). The model is sent
 * a cut-out on plain grey, never the removed background, and a result the
 * owner takes is cut out again when they chose Remove, so the order costs
 * nothing in quality. Step 5 is the finish itself: it is where a creation
 * being built is, never a step anyone opens or saves. */
export const WIZARD_STEPS: readonly WizardStep[] = ["frame", "background", "adjust", "points", "prepare"];

const ACTIVE: ReadonlySet<JobState> = new Set(["queued", "running"]);

export function isJobActive(job: CreationJob | null | undefined): boolean {
  return Boolean(job && ACTIVE.has(job.state));
}

/** Something is being computed and the creation will change without us:
 * a job, or a finish (which is a job, but also a status). Poll while so. */
export function isBusy(creation: Creation | null | undefined): boolean {
  return Boolean(creation && (isJobActive(creation.job) || creation.status === "finishing"));
}

/** Which offer a tab has acted on: one creation's image. */
export const autoAdjustKey = (creation: Creation, offer: AutoAdjust) => `${creation.id}:${offer.image}`;

/**
 * The touch-up to start without a press, or null.
 *
 * Only what the server offers (ai.auto_adjust), only on the member's own
 * remembered consent (a string: while it is loading, or when they have not
 * agreed yet, nothing starts, and nothing asks for it on their behalf),
 * never while something else runs, and once per image in this tab (the
 * server holds to once per photo for every tab).
 */
export function autoAdjustToStart(
  creation: Creation,
  consentId: string | null | undefined,
  started: ReadonlySet<string>
): AutoAdjust | null {
  const offer = creation.ai?.auto_adjust ?? null;
  if (!offer || typeof consentId !== "string" || creation.status !== "draft") return null;
  if (isJobActive(creation.job) || started.has(autoAdjustKey(creation, offer))) return null;
  return offer;
}

/** What building an avatar goes through, in order: its own words for each
 * (`createFinishStage_<stage>`), so the owner sees where the seconds go. A
 * person's mouth takes the longest of them: "shapes" is their teeth and
 * six mouth shapes, made by AI from the picture (counted, "3 of 7": the
 * teeth photo and the six shapes), "fit" the mouth fitted to them, and
 * "teeth" the teeth alone, where the server cannot make the shapes
 * (services.creations._own_mouth). */
export const FINISH_STAGES = ["copy", "rig", "layers", "shapes", "fit", "teeth", "publish"] as const;
export type FinishStage = (typeof FINISH_STAGES)[number];

/** The finish's last stage when a person's own mouth was not made after
 * all (no AI allowed, or it failed): the stages seen before it do not say
 * so (a kit that broke after its fourth shape goes straight to publishing). */
export const PUBLISH_STANDARD_LABEL = "publishing with the standard mouth";

// The labels services.creations._build_avatar reports its progress with
// (job.report). They are the server's log words, not a contract of their
// own: one this does not know shows no stage line, never a wrong one.
const FINISH_STAGE_LABELS: Readonly<Record<string, FinishStage>> = {
  "copying images": "copy",
  "building the rig": "rig",
  "building layers": "layers",
  "making the mouth shapes": "shapes",
  "fitting the mouth": "fit",
  "making the teeth": "teeth",
  publishing: "publish",
  [PUBLISH_STANDARD_LABEL]: "publish",
};

/** Is the finish publishing with the standard mouth instead of the
 * person's own? */
export function finishMouthStandard(job: CreationJob | null | undefined): boolean {
  return finishStage(job) === "publish" && job?.progress?.label === PUBLISH_STANDARD_LABEL;
}

/** The stage a running finish is at, or null (another job, queued, done,
 * or a label from a newer server). */
export function finishStage(job: CreationJob | null | undefined): FinishStage | null {
  if (!job || job.step !== "finish" || job.state !== "running") return null;
  const label = job.progress?.label;
  return label ? FINISH_STAGE_LABELS[label] ?? null : null;
}

/** How far a job's counted stage is ("3 of 6"), or null: only while it
 * runs, and only a count that adds up (the server's, but a shown "7 of 6"
 * would be worse than none). */
export function stageCount(job: CreationJob | null | undefined): JobCount | null {
  const count = job?.progress?.count;
  if (!count || job?.state !== "running") return null;
  const { done, total } = count;
  const whole = Number.isInteger(done) && Number.isInteger(total);
  return whole && total > 0 && done >= 0 && done <= total ? { done, total } : null;
}

/**
 * Will finishing this creation make the person's own mouth, as far as this
 * page can tell? A person (the photographic mouth), the organization's AI
 * switch on, and the member's own remembered consent (a string; unknown
 * while it loads): what the server checks too (services.creations
 * ._ai_allowed), less what only it knows (its image model, the monthly
 * image limit). Step 5 lists the mouth ahead of time on this; what the
 * server then reports always wins (finishRows).
 */
export function mouthExpected(creation: Creation, consentId: string | null | undefined): boolean {
  return creation.face_type === "human" && Boolean(creation.ai?.enabled) && typeof consentId === "string";
}

/**
 * Must finishing this creation ask the member for the AI statement first?
 * A person, whose own teeth and mouth shapes step 5 makes by AI when it may
 * (the organization's switch on), and a member known not to have agreed
 * under the words this page shows (null: never asked, or the words
 * changed; unknown while it loads, when nothing is asked). Asked at the
 * press that starts step 5, so nothing is sent without it and a member who
 * says "Not now" gets the avatar with the standard mouth.
 */
export function finishNeedsAiConsent(creation: Creation, consentId: string | null | undefined): boolean {
  return creation.face_type === "human" && Boolean(creation.ai?.enabled) && consentId === null;
}

/** The rows step 5 lists, in order (`createFinishPhase_<phase>`): copying,
 * rigging and layering are one ("build"); a person's mouth is "shapes"
 * (their teeth and mouth shapes, counted) then "fit", or "teeth" alone
 * where the server cannot make the shapes. */
export const FINISH_PHASES = ["build", "shapes", "fit", "teeth", "publish"] as const;
export type FinishPhase = (typeof FINISH_PHASES)[number];

const PHASE_OF: Readonly<Record<FinishStage, FinishPhase>> = {
  copy: "build",
  rig: "build",
  layers: "build",
  shapes: "shapes",
  fit: "fit",
  teeth: "teeth",
  publish: "publish",
};
const MOUTH_PHASES: readonly FinishPhase[] = ["shapes", "fit", "teeth"];

export interface FinishRow {
  phase: FinishPhase;
  /** "skipped": a person's mouth that was not made after all (the finish
   * publishes with the standard one): not done, and nothing to wait for. */
  state: "done" | "current" | "pending" | "skipped";
  /** The current "shapes" row's count ("3 of 7"); null on every other. */
  count: JobCount | null;
}

/**
 * Step 5's checklist for a finish: which rows it lists, and where the
 * build is. Empty for anything but a finish that is queued or running.
 *
 * The mouth rows are listed ahead of time when the finish will make the
 * person's mouth as far as the page knows (`expected`, mouthExpected).
 * What the server reports wins: a mouth stage it is at, or was seen at
 * (`seen`, the stages this page has watched go by), is listed whether
 * expected or not, and a teeth-only mouth replaces the shapes and their
 * fitting. Nothing is ticked that nobody saw happen, or that did not
 * happen: once the finish is publishing, the server says whether the
 * person's own mouth was made (finishMouthStandard). Made, the mouth rows
 * seen go on as done (the fitting, however quick, came before publishing);
 * not made (no AI allowed, or it failed), every mouth row listed is
 * "skipped", never ticked. A mouth never seen nor expected is not listed.
 * A stage this page does not know, or a queue, leaves every row pending:
 * no stage, never a wrong one.
 */
export function finishRows(
  job: CreationJob | null | undefined,
  expected: boolean,
  seen: ReadonlySet<FinishStage> = new Set()
): FinishRow[] {
  if (!job || job.step !== "finish" || !isJobActive(job)) return [];
  const stage = finishStage(job);
  const current = stage ? PHASE_OF[stage] : null;
  const phases = new Set<FinishPhase>([...seen].map((s) => PHASE_OF[s]));
  if (current) phases.add(current);
  const mouthSeen = MOUTH_PHASES.some((phase) => phases.has(phase));
  const beforeMouth = current === null || current === "build";
  const standard = finishMouthStandard(job);
  const order: FinishPhase[] = ["build"];
  if (mouthSeen || (expected && (beforeMouth || standard))) {
    order.push(...(phases.has("teeth") ? (["teeth"] as const) : (["shapes", "fit"] as const)));
  }
  order.push("publish");
  const at = current ? order.indexOf(current) : -1;
  return order.map((phase, i) => ({
    phase,
    state:
      standard && MOUTH_PHASES.includes(phase)
        ? "skipped"
        : at === -1 || i > at
          ? "pending"
          : i < at
            ? "done"
            : "current",
    count: phase === "shapes" && i === at ? stageCount(job) : null,
  }));
}

/**
 * What finishing the current image will warn about its mouth, known before
 * the press: the codes of the warnings the server's finish answer carries
 * (services.creations.mouth_warnings), read off the photo check of the
 * image on screen. An open mouth says it all (it is also why the lips are
 * parted), so it alone is named, as the server does. Empty when the check
 * is not about this image, or found neither.
 */
export function expectedMouthWarnings(creation: Creation): string[] {
  const reasons = recommendationOf(creation)?.reasons ?? [];
  if (reasons.includes("mouth_open")) return ["mouth_open"];
  if (reasons.includes("teeth_showing")) return ["teeth_showing"];
  return [];
}

// --- After finishing -----------------------------------------------------------

/**
 * What the owner is told on the avatar's page when they arrive from the
 * wizard: the finish answer's warnings. The wizard navigates by itself once
 * the avatar is built, so the answer would die with the step; it is kept
 * for this tab under the avatar's id (sessionStorage), until dismissed.
 * Step 5 reads it back too, so a tab reloaded mid-build still says them.
 */
export interface FinishNotice {
  warnings: FinishWarning[];
}

const FINISH_NOTICE_PREFIX = "liveface.finishNotice.";

export const finishNoticeKey = (avatarId: string) => `${FINISH_NOTICE_PREFIX}${avatarId}`;

/** Keep the finish answer's warnings for the avatar's page. Kept even when
 * there are none: arriving from the wizard is itself worth knowing (the
 * page also says what step 5 gave a person's mouth: their own shapes and
 * teeth, or standard ones and why). */
export function rememberFinishNotice(store: DraftStore | null, avatarId: string, warnings: FinishWarning[]): void {
  try {
    store?.setItem(finishNoticeKey(avatarId), JSON.stringify({ warnings }));
  } catch {
    // best effort: without it the page shows what the avatar itself says
  }
}

/** The notice kept for this avatar, or null. Only well-formed warnings
 * come back: the entry is a tab's storage, which anything can edit. */
export function finishNoticeFor(store: DraftStore | null, avatarId: string): FinishNotice | null {
  try {
    const raw = store?.getItem(finishNoticeKey(avatarId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { warnings?: unknown } | null)?.warnings;
    if (!Array.isArray(list)) return null;
    const warnings = list.filter(
      (w): w is FinishWarning =>
        Boolean(w) && typeof w.code === "string" && typeof (w.detail ?? "") === "string"
    ).map((w) => ({ code: w.code, detail: w.detail ?? "" }));
    return { warnings };
  } catch {
    return null;
  }
}

export function forgetFinishNotice(store: DraftStore | null, avatarId: string): void {
  try {
    store?.removeItem(finishNoticeKey(avatarId));
  } catch {
    // best effort
  }
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

/** A background removal's output: "cutout", or "cutout:N" (of adjusted:N). */
export function isCutoutId(id: string | null | undefined): boolean {
  return id === "cutout" || Boolean(id?.startsWith(CUTOUT_PREFIX));
}

/** Is this image transparent around the subject? A cut-out, or a touch-up
 * made from one (it keeps its alpha). Mirrors services.creations.is_cut_out. */
export function isTransparent(step: CreationStep | null | undefined): boolean {
  return Boolean(step && (step.cutout || isCutoutId(step.id)));
}

/** The id the background removal of `id` is stored under. */
export function cutoutIdFor(id: StepId): StepId {
  return isAdjusted(id) ? (`${CUTOUT_PREFIX}${id.slice(ADJUSTED_PREFIX.length)}` as StepId) : "cutout";
}

/** The cut-out made from `id`, when there is one. */
export function cutoutOf(creation: Creation, id: StepId | null | undefined): CreationStep | null {
  if (!id) return null;
  const cut = stepById(creation, cutoutIdFor(id));
  return cut && cut.from === id ? cut : null;
}

/** `id`, or when it is a background removal, the image it was cut from
 * (repeatedly): the image whose pixels it shows. */
function throughCutouts(creation: Creation, id: StepId | null | undefined): CreationStep | null {
  const seen = new Set<string>();
  let step = stepById(creation, id);
  while (step && isCutoutId(step.id) && !seen.has(step.id)) {
    seen.add(step.id);
    const source = stepById(creation, step.from);
    if (!source) break;
    step = source;
  }
  return step;
}

/** The image whose pixel grid the current image shares: a cut-out is its
 * source's grid (no pixel moved), every other step its own, an AI result
 * included (the model redrew it). Marks placed on one are valid on the
 * other. Mirrors services.creations.frame_key. */
export function frameOf(creation: Creation): StepId | null {
  return throughCutouts(creation, creation.current)?.id ?? null;
}

/** Do the anchors belong to the image the owner is looking at? Reframing,
 * switching line or choosing another frame clears or strands them. */
export function anchorsCurrent(creation: Creation): boolean {
  const anchors = creation.anchors;
  return Boolean(anchors && anchors.image !== null && anchors.image === frameOf(creation));
}

/** The opaque image behind the current one: the current image, or when
 * that is transparent (a cut-out, or a touch-up of one), the image it was
 * cut from. What "Keep original" goes back to, and what "Remove" cuts.
 * Mirrors services.creations.background_source. */
export function backgroundSource(creation: Creation): CreationStep | null {
  const seen = new Set<string>();
  let step = currentStep(creation);
  while (step && isTransparent(step) && !seen.has(step.id)) {
    seen.add(step.id);
    const source = stepById(creation, step.from);
    if (!source) break;
    step = source;
  }
  return step;
}

/** The original is stored and the line is known: the later steps can open. */
export function pastFirstStep(creation: Creation): boolean {
  return stepById(creation, "original") !== null && creation.face_type !== null;
}

/** The avatar is being built from this creation, or has been: step 5. */
function building(creation: Creation): boolean {
  return creation.status === "finishing" || creation.status === "finished";
}

/**
 * The step a creation opens on when the URL does not say (resuming from the
 * avatar list). Wherever work is running, or was last done. A finish that
 * failed is back on the points, where it is retried from what is on screen.
 */
export function inferStep(creation: Creation): WizardStep {
  if (building(creation)) return "prepare";
  if (!pastFirstStep(creation)) return "frame";
  const job = creation.job;
  if (job && (isJobActive(job) || jobFailure(job))) {
    if (job.step === "adjust") return "adjust";
    // Cutting out an AI result the owner just took is part of taking it.
    if (job.step === "background") return aiResultInUse(creation) ? "adjust" : "background";
    if (job.step === "detect" || job.step === "finish") return "points";
  }
  if (creation.anchors) return "points";
  // An AI round was asked for: its results wait to be compared.
  if (adjustedSteps(creation).length > 0 || creation.ai?.last_round) return "adjust";
  // Step 2 was worked on last: back there, to Continue from it.
  if (creation.background || creation.steps.some((step) => isCutoutId(step.id))) return "background";
  return "frame";
}

/** The step to show: the one asked for (in the URL) when the creation can
 * be there, else the inferred one. A creation being built is always on
 * step 5, whatever the URL says, and only such a creation is: asking for
 * "prepare" is never a way to skip the points. */
export function resolveStep(creation: Creation, requested: string | null): WizardStep {
  if (building(creation)) return "prepare";
  const asked = WIZARD_STEPS.find((step) => step === requested);
  if (!asked || asked === "prepare") return inferStep(creation);
  if (asked !== "frame" && !pastFirstStep(creation)) return "frame";
  return asked;
}

// --- Photo findings -------------------------------------------------------------------

/** Check codes with our own words (photoCheck_<code>); others show the
 * server's sentence. */
export const PHOTO_CHECKS: ReadonlySet<string> = new Set([
  "face_small", "face_at_edge", "head_turned", "low_resolution", "no_face", "blurry", "too_dark", "too_bright",
  "eyes_closed", "mouth_open", "eyes_half_closed", "gaze_off_camera", "teeth_showing", "head_tilted",
  // Warnings of an AI point search that fell back to the template.
  "ai_points_failed", "ai_no_face", "ai_points_implausible", "safety_refused", "vision_limit_reached",
]);

/** Checks that are not news on the line chosen: "no human face" on a dog
 * is the reason it is a dog. */
const NOT_A_PROBLEM_FOR: Record<string, readonly FaceType[]> = {
  no_face: ["animal", "cartoon"],
  head_turned: ["animal"],
};

/** The analysis' findings worth telling the owner of a `line` picture.
 * With no line chosen yet, "no human face" is left out: it is asked about
 * as a question (which line?) instead. */
export function photoFindings(analysis: CreationAnalysis | null | undefined, line: FaceType | null): PhotoCheck[] {
  return (analysis?.checks ?? []).filter((check) =>
    line ? !NOT_A_PROBLEM_FOR[check.code]?.includes(line) : check.code !== "no_face"
  );
}

// --- AI adjust ----------------------------------------------------------------------

export const ADJUSTED_PREFIX = "adjusted:";
export const CUTOUT_PREFIX = "cutout:";
export const ADJUST_STYLES: readonly AdjustStyle[] = ["photoreal", "illustrated", "anime", "render3d"];
/** The order the options are offered in; the server says which a line has. */
export const ADJUST_MODES: readonly AdjustMode[] = ["touchup", "stylise", "regenerate"];

/** What a touch-up fixes: the eyes and parted lips, nothing else.
 * services.photo_analysis.TOUCHUP_REASONS. */
export const TOUCHUP_REASONS: readonly string[] = [
  "eyes_closed", "eyes_half_closed", "gaze_off_camera", "teeth_showing",
];
/** What only a regenerated picture fixes (pose, light, size, sharpness, and
 * an open mouth: closing it moves the jaw, which pasted lips cannot follow).
 * services.photo_analysis.REGENERATE_REASONS. */
export const REGENERATE_REASONS: readonly string[] = [
  "no_face", "head_turned", "head_tilted", "face_small", "low_resolution", "too_dark", "too_bright", "blurry",
  "mouth_open",
];
/** The reasons an animal or an animation is judged on: a face to find,
 * facing the camera. Worded for a drawing or a pet, not "your eyes". */
export const DRAWN_REASONS: ReadonlySet<string> = new Set(["no_face", "head_turned"]);

export function isAdjusted(id: string | null | undefined): boolean {
  return Boolean(id && id.startsWith(ADJUSTED_PREFIX));
}

/** Every AI candidate stored so far, both rounds, in the server's order. */
export function adjustedSteps(creation: Creation): CreationStep[] {
  return creation.steps.filter((step) => isAdjusted(step.id));
}

/**
 * What step 3 recommends for the image on screen, or null. Only while it
 * was computed on the current image: a response is always fresh, but a
 * creation held in the cache across a choice must not show the last
 * image's reasons as this one's.
 */
export function recommendationOf(creation: Creation): Recommendation | null {
  const found = creation.analysis?.recommendation ?? null;
  return found && found.image === creation.current ? found : null;
}

/** The fix to pre-select: the recommended one, when this line offers it
 * and AI is on. Null when the photo needs nothing: nothing paid is ever
 * selected for the owner on a photo that is fine. */
export function preselectedMode(creation: Creation): AdjustMode | null {
  const offered = adjustModes(creation);
  return (creation.ai?.suggested ?? []).find((mode) => offered.includes(mode)) ?? null;
}

/** The AI result the owner is using, seen through its cut-out ("cutout:1"
 * shows "adjusted:1"), or null when the current image is not one. */
export function aiResultInUse(creation: Creation): CreationStep | null {
  const shown = throughCutouts(creation, creation.current);
  return shown && isAdjusted(shown.id) ? shown : null;
}

/** Is `id` the picture on screen, directly or as its cut-out? */
export function inUse(creation: Creation, id: StepId): boolean {
  return throughCutouts(creation, creation.current)?.id === id;
}

/** The image the last AI round was made from: the "before" of the
 * before/after. Null without a round, or once that image is gone (a new
 * framing drops every AI result and what they were made from). */
export function roundSource(creation: Creation): CreationStep | null {
  const source = creation.ai?.last_round?.source;
  return source ? stepById(creation, source) : null;
}

/** The last round's versions, each with its picture when it has one. */
export function roundResults(creation: Creation): { candidate: AdjustCandidate; step: CreationStep | null }[] {
  return (creation.ai?.last_round?.candidates ?? []).map((candidate) => ({
    candidate,
    step: candidate.step ? stepById(creation, candidate.step) : null,
  }));
}

/**
 * What "Keep my photo" chooses: the round's "before", as its cut-out when
 * the owner removed the background (choosing an image never cuts it out
 * by itself, only an AI result). Null when that picture is on screen
 * already, so keeping it is just carrying on.
 */
export function keepChoice(creation: Creation): StepId | null {
  const source = roundSource(creation);
  if (!source) return null;
  if (throughCutouts(creation, creation.current)?.id === throughCutouts(creation, source.id)?.id) return null;
  if (creation.background === "remove" && !isTransparent(source)) {
    const cut = cutoutOf(creation, source.id);
    if (cut) return cut.id;
  }
  return source.id;
}

/** Can this candidate be chosen? Rejected ones are shown, never used. */
export function choosable(step: CreationStep): boolean {
  return !step.adjust?.rejected;
}

export interface AiEdit {
  mode: AdjustMode | "generate";
  model: string | null;
  generated_eyes: boolean;
}

/**
 * Did an AI make or change the picture `id` shows (the current one by
 * default)? The latest AI adjust in its lineage, else a generated original;
 * null for a photo as its owner gave it (framing and cut-outs are not AI
 * edits). Mirrors services.creations.ai_edited_of, which decides the
 * disclosure the published avatar carries.
 */
export function aiEditOf(creation: Creation, id: StepId | null = creation.current): AiEdit | null {
  const seen = new Set<string>();
  let step = stepById(creation, id);
  while (step && !seen.has(step.id)) {
    seen.add(step.id);
    if (step.adjust) {
      return { mode: step.adjust.mode, model: step.adjust.model, generated_eyes: step.adjust.generated_eyes };
    }
    if (step.generated) return { mode: "generate", model: step.generated.model, generated_eyes: false };
    step = stepById(creation, step.from);
  }
  return null;
}

/** The adjust modes to offer, in order: none while AI is switched off. */
export function adjustModes(creation: Creation): AdjustMode[] {
  if (!creation.ai?.enabled) return [];
  return ADJUST_MODES.filter((mode) => creation.ai.modes.includes(mode));
}

/**
 * Whether the points step offers "Find the points with AI", and in what
 * state. Only where the detector cannot see: always for an animal, for an
 * animation only when MediaPipe found nothing (a detected face is better
 * than the model's guess). Never for a person. "spent" means the one AI
 * look this creation gets was used on other pixels.
 */
export type AiPointsOffer = "offer" | "spent" | null;

export function aiPointsOffer(
  creation: Creation,
  anchors: Pick<CreationAnchors, "detected" | "source"> | null
): AiPointsOffer {
  if (!creation.ai?.enabled || !anchors) return null;
  if (creation.face_type === "human" || creation.face_type === null) return null;
  if (creation.face_type === "cartoon" && anchors.detected) return null;
  // The model's points are already on screen: asking again is the button
  // "Detect again" is for, and would cost the one look.
  if (anchors.source === "ai") return null;
  return creation.ai.ai_detections_left > 0 ? "offer" : "spent";
}

/**
 * Which statement finishing needs, if any (the server decides, from where
 * the pixels came from). A server that does not say yet asked it of every
 * person, and only of a person.
 */
export function statementNeeded(creation: Creation): FaceStatement | null {
  if (creation.statement !== undefined) return creation.statement;
  return (creation.face_type ?? "human") === "human" ? "depiction" : null;
}

/** Why a candidate failed, in the owner's words (adjustReason_<code>). */
export const CANDIDATE_REASONS: ReadonlySet<string> = new Set([
  "safety_refused",
  "no_image",
  "provider_error",
  "unreadable_result",
  "no_face_in_result",
  "alignment_failed",
  "jaw_moved",
  "fit_invalid",
  "skin_tone_changed",
  "check_failed",
]);

export function candidateReasonText(t: Translate, reason: PhotoCheck): string {
  return CANDIDATE_REASONS.has(reason.code) ? t(`adjustReason_${reason.code}`) : reason.detail || t("error");
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
/** A finish backs off no further than this: step 5 counts the mouth
 * shapes as they are made ("3 of 6", one every few seconds), and a count
 * that jumps by three at a time does not look live. A minute of it is
 * about thirty requests. */
export const FINISH_POLL_MAX_MS = 2000;

/**
 * Delay before the `attempt`-th poll (0-based) of one job. Ingest and
 * detection are about a second, so the first answers come quickly; a
 * background removal or a queue wait can take a minute, and a tab left
 * open on it should not ask twice a second the whole time. A finish
 * (`finishing`) is watched more closely (FINISH_POLL_MAX_MS).
 */
export function pollDelay(attempt: number, finishing = false): number {
  const ceiling = finishing ? FINISH_POLL_MAX_MS : POLL_MAX_MS;
  return Math.min(ceiling, Math.round(POLL_FIRST_MS * POLL_FACTOR ** Math.max(0, attempt)));
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
  // M4: consent, AI adjust, AI points, generation.
  "consent_required",
  "consent_outdated",
  "unknown_consent_version",
  "unknown_provider",
  "third_party_ai_disabled",
  "adjust_not_for_face_type",
  "style_required",
  "imagegen_unavailable",
  "budget_spent",
  "image_limit_reached",
  "candidate_rejected",
  "ai_points_not_for_face_type",
  "ai_points_unavailable",
  "face_turned",
  "no_face_for_touchup",
  "landmarks_unavailable",
  "provider_error",
  "no_image",
  "safety_refused",
  "source_gone",
  "avatar_not_found",
  "not_a_photo",
  // The avatar page's Retry, for an avatar step 5 is still preparing.
  "avatar_preparing",
  "image_missing",
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
