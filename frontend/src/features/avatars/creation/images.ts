/** A creation's images, and the step the wizard opens on (see index.ts). */
import { ADJUSTED_PREFIX, adjustedSteps, aiResultInUse, CUTOUT_PREFIX, isAdjusted } from "./adjust.ts";
import { isJobActive, jobFailure, WIZARD_STEPS, type WizardStep } from "./jobs.ts";
import type { Creation, CreationStep, StepId } from "./types.ts";

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
export function throughCutouts(creation: Creation, id: StepId | null | undefined): CreationStep | null {
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
