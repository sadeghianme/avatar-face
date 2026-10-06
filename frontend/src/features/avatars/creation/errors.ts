/** A refusal in the wizard's words (see index.ts). */

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
  // The four-step wizard's step 3 (wizard.ts, POST /prepare).
  "original_not_for_look",
  "instruction_required",
  "generate_not_for_upload",
  "plan_incomplete",
  "plan_with_source",
]);

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * An error for the owner: our sentence for the code when there is one,
 * the server's otherwise, and when the server said how long to wait
 * (Retry-After on a busy queue), that too.
 */
export function errorText(t: Translate, code: string, detail: string, retryAfter: number | null = null): string {
  const text = KNOWN_ERRORS.has(code) ? t(`createErr_${code}`) : detail || t("error");
  return retryAfter ? `${text} ${t("createRetryAfter", { count: retryAfter })}` : text;
}
