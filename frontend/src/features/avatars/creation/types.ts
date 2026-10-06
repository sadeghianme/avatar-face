/** A creation as the creations API returns it: its shapes (see index.ts). */
import type { FaceStatement } from "@/features/avatars/consent";
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import type { FaceType } from "@/lib/types";

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
export type JobStep =
  | "ingest"
  | "generate"
  | "adjust"
  | "background"
  | "detect"
  | "finish"
  | "mouth_kit"
  // The four-step wizard's step 3 (wizard.ts).
  | "prepare";
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
  /** The name the wizard proposes, decided once by the server when the
   * creation was made (the description's words, or a file name that means
   * something). Null when nothing was worth a name: the plan's own then
   * (wizard.avatarName). Absent from a server before it said so. */
  name?: string | null;
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
