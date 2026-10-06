/** A creation's steps and jobs, and the finish's stages and rows (see index.ts). */
import { recommendationOf } from "./adjust.ts";
import type { AutoAdjust, Creation, CreationJob, JobCount, JobState, PhotoCheck } from "./types.ts";

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
  return label ? (FINISH_STAGE_LABELS[label] ?? null) : null;
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
 * is not about this image, or found neither; and on every line but the
 * human one, whose photographic mouth is the picture's own lips (an
 * animal's muzzle and a drawing's mouth are drawn over the picture, and
 * the detector's "mouth" on a muzzle says nothing).
 */
export function expectedMouthWarnings(creation: Creation): string[] {
  if (creation.face_type !== "human") return [];
  const reasons = recommendationOf(creation)?.reasons ?? [];
  if (reasons.includes("mouth_open")) return ["mouth_open"];
  if (reasons.includes("teeth_showing")) return ["teeth_showing"];
  return [];
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
