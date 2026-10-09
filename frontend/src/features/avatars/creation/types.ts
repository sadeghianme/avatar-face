/**
 * A creation as the creations API returns it: the backend's schemas
 * (CreationOut, StepOut, JobOut, AnchorsOut, AiOut… in lib/api-types.ts),
 * with what the server sends as a dict or a plain string said precisely
 * here (Refine names only fields the schema has). See index.ts.
 */
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import type { Refine, Schemas } from "@/lib/types";

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
  /** An adjust round's mode, or "generate": a picture made anew from the
   * description (a described character's Retry, services.wizard). */
  mode: AdjustMode | "generate";
  style: AdjustStyle | null;
  model: string;
  /** The photo's eyes were closed and these are the model's invention:
   * the owner must be told, every time the image is shown as a choice. */
  generated_eyes: boolean;
  /** Failed its checks: shown with the reason, never choosable. */
  rejected: PhotoCheck | null;
  checks: { detected?: boolean; fit_ok?: boolean; skin_delta_e?: number };
  /** The owner's words for a change ("Describe a change", step 3); null or
   * absent for a plain try. */
  instruction?: string | null;
}

/**
 * An image of the creation. `url` is presigned, with a fresh signature on
 * every response (see stabilizeUrls). `cutout`: transparent around the
 * subject, a background removal ("cutout", "cutout:N") or a touch-up of
 * one (it keeps the cut-out's alpha).
 */
export type CreationStep = Refine<
  Schemas["StepOut"],
  {
    id: StepId;
    from: StepId | null;
    crop: CropRect | null;
    roll: number | null;
    /** On "adjusted:N" only. */
    adjust?: StepAdjust | null;
    /** On an original the image model made (POST /creations/generate). */
    generated?: { model: string; style: AdjustStyle; provider: "gemini" } | null;
  }
>;

/** A check's or a job's refusal: a code to word, and the server's sentence. */
export type PhotoCheck = Schemas["JobError"];

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

export type AnchorValidation = Refine<Schemas["Validation"], { reasons: FitReason[]; warnings: PhotoCheck[] }>;

/**
 * The face's points on one image. `source`: where the opening marks came
 * from (a detection, the template's guess, or the vision model's points, a
 * pre-fill the owner still confirms); null on anchors made before it was
 * recorded.
 */
export type CreationAnchors = Refine<
  Schemas["AnchorsOut"],
  {
    /** The step whose pixels the marks are in; null once that image is gone. */
    image: StepId | null;
    image_size: [number, number];
    marks: FaceMarks;
    validation: AnchorValidation;
  }
>;

/** A job's step: a creation's, "mouth_kit" (an avatar's mouth made from its
 * photo in the Mouth panel, the same JobOut shape), or "prepare", the
 * four-step wizard's step 3 (wizard.ts). */
export type JobStep = Schemas["JobOut"]["step"];
export type JobState = Schemas["JobOut"]["state"];

/** How far a counted stage is: "3 of 6" mouth shapes settled (made, or
 * given up on for the standard one). */
export type JobCount = Schemas["JobCount"];

/**
 * A job. `progress` is live while queued or running, null once it has
 * ended; its `count` belongs to its label only (a new label clears it).
 * `error` and `progress` are always sent (null when there is none).
 */
export type CreationJob = Refine<
  Schemas["JobOut"],
  { error: PhotoCheck | null; progress: Schemas["JobProgress"] | null }
>;

export type CreationStatus = Schemas["CreationOut"]["status"];

/** One candidate of a round. `step` holds the image; null when there is
 * none to show (a safety refusal, a provider error, a result with no face
 * in it). */
export type AdjustCandidate = Refine<Schemas["AdjustCandidateOut"], { step: StepId | null; reason: PhotoCheck | null }>;

/** An AI adjust round: `source` is the image it was made from;
 * `limit_reached`, the monthly image limit stopped it before every
 * candidate. */
export type AdjustRound = Refine<
  Schemas["AdjustRoundOut"],
  { mode: AdjustMode; style: AdjustStyle | null; source: StepId; candidates: AdjustCandidate[] }
>;

/**
 * The creation's AI step: what is offered, what is left, what happened.
 * `enabled` is false when an owner or admin turned third-party AI off;
 * `modes`, the adjust modes this line offers (empty until the line is
 * known); `suggested`, the recommended mode when the current image needs
 * a fix this line offers (pre-selected; empty when nothing needs fixing,
 * so nothing paid is ever pre-selected on a photo that is fine);
 * `auto_adjust`, a touch-up the wizard starts by itself
 * (autoAdjustToStart). Step 3's tries and free removals left are
 * `prepare_rounds_left` and `free_clears_left`; its last try,
 * `last_prepare` (wizard.ts, WizardCreation).
 */
export type CreationAi = Refine<
  Schemas["AiOut"],
  { modes: AdjustMode[]; suggested: AdjustMode[]; last_round: AdjustRound | null; auto_adjust?: AutoAdjust | null }
>;

/** The server's offer of a touch-up nobody has to press for: a person whose
 * parted lips show their teeth (they would stay painted on the lips as the
 * avatar talks), and whose eyes the same touch-up fixes when the check
 * found them wanting too (`reasons`). Once per photo; the owner still
 * chooses the result. */
export type AutoAdjust = Refine<Schemas["AutoAdjustOut"], { image: StepId }>;

/**
 * A creation. From the schema as it is: `face_type` (null until the owner,
 * or the analysis, said what the face is), `status`, `revision`,
 * `background` (the step 2 answer; null until given, and again after a
 * change of line), `statement` (the statement finishing needs, recorded
 * for it: "depiction" for a person's photo, "generated_face" for a face
 * made from words), `name` (the one the wizard proposes, decided once by
 * the server; null when nothing was worth a name, wizard.avatarName) and
 * `plan`. Said precisely here: its images and its job, the analysis (a
 * dict on the server), and why a background cannot be removed.
 */
export type Creation = Refine<
  Schemas["CreationOut"],
  {
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
    ai: CreationAi;
  }
>;

/** The rig the finish would build, fitted and not saved: what refuses it
 * (`reasons`), and what was smoothed on the way (`notes`: thin triangles
 * between the points that would have folded; nothing to act on). */
export type PreviewRig = Refine<Schemas["PreviewRigOut"], { reasons: FitReason[] }>;

/** Something the finished picture still shows around the mouth
 * ("mouth_open", "teeth_showing"): said, not refused. */
export type FinishWarning = Schemas["FinishWarning"];

export type FinishResult = Refine<Schemas["FinishOut"], { creation: Creation }>;
