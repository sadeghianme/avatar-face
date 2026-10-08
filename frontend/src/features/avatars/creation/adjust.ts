/** The AI adjust: its rounds, candidates, and the edits in use (see index.ts). */
import type { FaceStatement } from "@/features/avatars/consent";

import type { Translate } from "./errors.ts";
import { cutoutOf, isTransparent, stepById, throughCutouts } from "./images.ts";
import type {
  AdjustCandidate,
  AdjustMode,
  AdjustStyle,
  Creation,
  CreationAnchors,
  CreationStep,
  PhotoCheck,
  Recommendation,
  StepId,
} from "./types.ts";

export const ADJUSTED_PREFIX = "adjusted:";
export const CUTOUT_PREFIX = "cutout:";
export const ADJUST_STYLES: readonly AdjustStyle[] = ["photoreal", "illustrated", "anime", "render3d"];
/** The order the options are offered in; the server says which a line has. */
export const ADJUST_MODES: readonly AdjustMode[] = ["touchup", "stylise", "regenerate"];

/** What a touch-up fixes: the eyes and parted lips, nothing else.
 * services.photo_analysis.TOUCHUP_REASONS. */
export const TOUCHUP_REASONS: readonly string[] = [
  "eyes_closed",
  "eyes_half_closed",
  "gaze_off_camera",
  "teeth_showing",
];
/** What only a regenerated picture fixes (pose, light, size, sharpness, and
 * an open mouth: closing it moves the jaw, which pasted lips cannot follow).
 * services.photo_analysis.REGENERATE_REASONS. */
export const REGENERATE_REASONS: readonly string[] = [
  "no_face",
  "head_turned",
  "head_tilted",
  "face_small",
  "low_resolution",
  "too_dark",
  "too_bright",
  "blurry",
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
export const CANDIDATE_REASON_CODES = [
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
] as const;
export const CANDIDATE_REASONS: ReadonlySet<string> = new Set(CANDIDATE_REASON_CODES);
const isCandidateReason = (code: string): code is (typeof CANDIDATE_REASON_CODES)[number] =>
  CANDIDATE_REASONS.has(code);

export function candidateReasonText(t: Translate, reason: PhotoCheck): string {
  return isCandidateReason(reason.code) ? t(`adjustReason_${reason.code}`) : reason.detail || t("error");
}
