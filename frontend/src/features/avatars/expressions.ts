/**
 * The avatar's AI expression pictures as the dashboard tells the owner about
 * them (services.expressions on the server): five pictures of this face,
 * happy, surprised, concerned, thinking and serious, made by the image model
 * from the avatar's photo; each one the AI could not make stays animated.
 *
 * GET …/expressions says the owner's choice, how a publish makes missing
 * ones (now, or as a batch: cheaper, ready within hours), what was made and
 * why the rest were not, and the job while it runs. PUT sets the choice,
 * POST …/make makes them now, DELETE removes them.
 *
 * Framework-free, importing only types, so its rules run under node --test.
 */
import type { CreationJob } from "@/features/avatars/creation";
import type { MessageKey } from "@/i18n/types";
import type { Refine, Schemas } from "@/lib/types";

/** What GET, PUT, POST and DELETE …/expressions answer. */
export type ExpressionsView = Refine<Schemas["ExpressionsOut"], { job: CreationJob | null }>;
export type Delivery = NonNullable<Schemas["ExpressionsOut"]["delivery"]>;

/** The five, in the engine's order, each with its own name (`exprName_<name>`). */
export const EXPRESSION_NAMES = ["happy", "surprised", "concerned", "thinking", "serious"] as const;
export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

/** How often the panel asks after its job (five edits, three at a time). */
export const EXPR_POLL_MS = 1500;
/** How often it asks after a batch on its way (minutes to hours). */
export const EXPR_BATCH_POLL_MS = 60_000;

export const EXPR_STAGES = ["making", "saving", "batch"] as const;
export type ExprStage = (typeof EXPR_STAGES)[number];

// services.expression_kit's progress labels; one this does not know shows
// no stage, never a wrong one.
const STAGE_LABELS: Readonly<Record<string, ExprStage>> = {
  "making the expressions": "making",
  saving: "saving",
  "sending the batch": "batch",
};

export function isExprActive(job: CreationJob | null | undefined): boolean {
  return job?.state === "queued" || job?.state === "running";
}

/** The stage a running expressions job is at, or null. */
export function exprStage(job: CreationJob | null | undefined): ExprStage | null {
  if (!job || job.step !== "expression_kit" || job.state !== "running") return null;
  const label = job.progress?.label;
  return label ? (STAGE_LABELS[label] ?? null) : null;
}

/** How often to ask again: while a job runs, while a batch is on its way, or not. */
export function pollEvery(view: ExpressionsView | undefined): number | false {
  if (!view) return false;
  if (isExprActive(view.job)) return EXPR_POLL_MS;
  return view.pending ? EXPR_BATCH_POLL_MS : false;
}

/** Why an expression was not made, in the panel's words: a few kinds the
 * owner can act on, or none (the server's own sentence is then shown). */
export const SHOT_REASONS = ["declined", "notReached", "changed", "stopped", "failed"] as const;
export type ShotReason = (typeof SHOT_REASONS)[number];

const REASON_KINDS: Readonly<Record<string, ShotReason>> = {
  safety_refused: "declined",
  no_image: "declined",
  expression_not_reached: "notReached",
  head_moved: "changed",
  registration: "changed",
  nose_moved: "changed",
  head_turned: "changed",
  eyes_moved: "changed",
  skin_tone_changed: "changed",
  aspect_changed: "changed",
  mirrored: "changed",
  no_face_in_result: "changed",
  third_party_ai_disabled: "stopped",
  image_limit_reached: "stopped",
  imagegen_unavailable: "stopped",
  consent_not_recorded: "stopped",
  timeout: "failed",
  provider_error: "failed",
  check_failed: "failed",
  unreadable_result: "failed",
};

export function shotReason(code: string | null | undefined): ShotReason | null {
  return code ? (REASON_KINDS[code] ?? null) : null;
}

export interface ShotView {
  name: ExpressionName;
  made: boolean;
  /** The made picture, presigned, for the preview grid. */
  pictureUrl: string | null;
  smile: boolean;
  /** Why it was not made: a key, or the server's sentence. */
  reasonKey: MessageKey | null;
  reasonText: string | null;
}

/** Each of the five as the grid shows it: made with its picture, or why
 * not; all five "not made, no reason" before any kit. */
export function shotsView(view: ExpressionsView | undefined): ShotView[] {
  const shots = view?.kit?.shots ?? {};
  return EXPRESSION_NAMES.map((name) => {
    const shot = shots[name];
    const made = shot?.status === "ok";
    const kind = made ? null : shotReason(shot?.reason?.code);
    return {
      name,
      made,
      pictureUrl: (made && view?.picture_urls?.[name]) || null,
      smile: Boolean(shot?.smile),
      reasonKey: kind ? (`exprReason_${kind}` as const) : null,
      reasonText: !made && !kind ? (shot?.reason?.detail ?? null) : null,
    };
  });
}

/** The section's one-word summary, folded. */
export function summaryKey(view: ExpressionsView | undefined): MessageKey {
  if (!view?.ai) return "exprSummaryOff";
  if (view.pending || isExprActive(view.job)) return "exprSummaryMaking";
  return (view.kit?.made ?? 0) > 0 ? "exprSummaryOn" : "exprSummaryChosen";
}

/** A refused request, in the panel's words when it knows the code. */
export function refusalKey(code: string): MessageKey | null {
  switch (code) {
    case "third_party_ai_disabled":
      return "exprErr_disabled";
    case "image_limit_reached":
      return "exprErr_limit";
    case "imagegen_unavailable":
      return "exprErr_unavailable";
    case "not_a_person":
      return "exprErr_person";
    case "expressions_in_progress":
      return "exprErr_busy";
    default:
      return null;
  }
}
