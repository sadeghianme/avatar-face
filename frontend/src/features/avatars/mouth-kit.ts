/**
 * A person's own mouth, made from their avatar's picture (the mouth kit,
 * docs/performance-kit.md), as the dashboard tells the owner about it.
 *
 * Step 5 of the wizard makes it as a person's avatar is built; the Mouth
 * panel's one AI action makes it again for an avatar that exists, as a job:
 * POST …/mouth-kit, then GET the same path until it ends. What a kit is
 * made of comes with the avatar (`mouth.kit`): how many of its six shapes
 * the AI made from the photo, why the others are the standard ones fitted
 * to the face, and whether its teeth photo became the avatar's.
 *
 * Framework-free, importing only types (as creation/ does), so the rules are
 * tested with `node --test`.
 */
import type { CreationJob, DraftStore, Translate } from "@/features/avatars/creation";
import type { TeethView } from "@/features/avatars/teeth";
import type { MessageKey } from "@/i18n/types";
import type { Avatar, MouthShape, Reason } from "@/lib/types";

/** The panel's job (step "mouth_kit"): a creation job's shape. */
export type KitJob = CreationJob;

/** What POST and GET …/mouth-kit answer. Null: this server ran none for
 * the avatar since it started. */
export interface KitJobAnswer {
  job: KitJob | null;
}

/** The six shapes, in the manifest's order, each with its own name for
 * the owner (`mouthShape_<shape>`). */
export const KIT_SHAPES: readonly MouthShape[] = ["aa", "ee", "oo", "oh", "fv", "th"];

/** How often the panel asks after its job: six image edits, three at a
 * time, settle one every few seconds. */
export const KIT_POLL_MS = 1500;

/** Whether `code` is one of `codes`, narrowed to them: a key made from it
 * (`mouthReason_${code}`) is then checked against en's keys. */
function oneOf<T extends string>(codes: readonly T[], code: string): code is T {
  return (codes as readonly string[]).includes(code);
}

// --- The panel's job ---------------------------------------------------------------

/** Where the panel's job is, in its own words (`mouthKitStage_<stage>`):
 * the shapes (counted), their fitting, the teeth alone where the server
 * cannot make shapes, and the saving. */
export const KIT_STAGES = ["shapes", "fit", "teeth", "save"] as const;
export type KitStage = (typeof KIT_STAGES)[number];

// services.mouth_kit's progress labels. As for a finish, a label this does
// not know shows no stage, never a wrong one.
const KIT_STAGE_LABELS: Readonly<Record<string, KitStage>> = {
  "making the mouth shapes": "shapes",
  "fitting the mouth": "fit",
  "making the teeth": "teeth",
  saving: "save",
};

export function isKitActive(job: KitJob | null | undefined): boolean {
  return job?.state === "queued" || job?.state === "running";
}

/** The stage a running kit job is at, or null. */
export function kitStage(job: KitJob | null | undefined): KitStage | null {
  if (!job || job.step !== "mouth_kit" || job.state !== "running") return null;
  const label = job.progress?.label;
  return label ? (KIT_STAGE_LABELS[label] ?? null) : null;
}

/**
 * What the panel makes of the job GET …/mouth-kit shows, given the id of
 * the one this tab started (`held`, kept across a reload), if any:
 * - running: queued or running, this tab's or one found running (another
 *   tab's, or the one a 409 mouth_kit_in_progress said was there);
 * - done, failed: this tab's job ended so;
 * - interrupted: this tab's job is gone (a restart forgets jobs, and the
 *   server then knows none or another), or the runner says so;
 * - null: nothing to say. A job someone else started that has ended left
 *   its result in the avatar, which says it.
 */
export type KitOutcome =
  | { kind: "running"; job: KitJob }
  | { kind: "done"; job: KitJob }
  | { kind: "failed"; job: KitJob; error: Reason }
  | { kind: "interrupted" };

export function kitOutcome(job: KitJob | null | undefined, held: string | null): KitOutcome | null {
  if (job && isKitActive(job)) return { kind: "running", job };
  if (!held) return null;
  if (!job || job.id !== held || job.state === "interrupted") return { kind: "interrupted" };
  if (job.state === "done") return { kind: "done", job };
  return { kind: "failed", job, error: job.error ?? { code: "job_failed", detail: "" } };
}

const KIT_JOB_PREFIX = "liveface.mouthKitJob.";

export const kitJobKey = (avatarId: string) => `${KIT_JOB_PREFIX}${avatarId}`;

/**
 * The job this tab started for an avatar, kept for the tab
 * (sessionStorage): a reload mid-job picks it up again, and one that ended
 * meanwhile still says how. Null forgets it. Best effort: without storage,
 * a reload only finds a job still running.
 */
export function rememberKitJob(store: DraftStore | null, avatarId: string, jobId: string | null): void {
  try {
    if (jobId) store?.setItem(kitJobKey(avatarId), jobId);
    else store?.removeItem(kitJobKey(avatarId));
  } catch {
    // storage blocked or full: see above
  }
}

export function heldKitJob(store: DraftStore | null, avatarId: string): string | null {
  try {
    return store?.getItem(kitJobKey(avatarId)) || null;
  } catch {
    return null;
  }
}

// --- What a kit is made of ------------------------------------------------------------

/** A shape the kit could not make from the photo: the standard one, fitted
 * to the face, and why. */
export interface StandardShape {
  shape: MouthShape;
  reason: Reason | null;
}

/**
 * Where the photographic mouth's shapes come from:
 * - own: all of them made by AI from the photo;
 * - mixed: some of them, the rest standard (`standard` says which, and why);
 * - standard: none from this photo. `kit` says whether one was ever made
 *   ("none"), made with no shape of its own ("made", `standard` says why),
 *   or dropped since ("dropped": `dropped` says why, e.g. made for the
 *   previous picture).
 * Null for the classic mouth, whose movement is drawn.
 */
export type ShapesView =
  | { kind: "own"; generated: number; total: number }
  | { kind: "mixed"; generated: number; total: number; standard: StandardShape[] }
  | { kind: "standard"; kit: "none" | "made" | "dropped"; standard: StandardShape[]; dropped: Reason | null };

export function shapesView(mouth: Avatar["mouth"]): ShapesView | null {
  if (!mouth || mouth.renderer !== "continuous") return null;
  const kit = mouth.kit ?? null;
  if (!kit) return { kind: "standard", kit: "none", standard: [], dropped: null };
  if (kit.state === "dropped") return { kind: "standard", kit: "dropped", standard: [], dropped: kit.dropped ?? null };
  const shapes = kit.shapes ?? [];
  const standard = shapes
    .filter((entry) => entry.provenance !== "generated")
    .map((entry) => ({ shape: entry.shape, reason: entry.reason ?? null }));
  // The list is the truth; the counts stand in only if a server left it out.
  const total = shapes.length || KIT_SHAPES.length;
  const generated = shapes.length ? total - standard.length : Math.min(kit.generated, total);
  if (generated <= 0) return { kind: "standard", kit: "made", standard, dropped: null };
  if (generated >= total) return { kind: "own", generated, total };
  return { kind: "mixed", generated, total, standard };
}

/** Why a dropped kit's shapes are no longer the avatar's, with a sentence
 * of their own (`mouthShapesDropped_<code>`): made for the previous
 * picture, unable to follow new points, or their file gone. */
export const KIT_DROPPED_CODES = ["picture_changed", "rebase_failed", "motion_missing"] as const;

/** Where the shapes come from, in a few words beside the teeth's (the
 * Mouth panel): "Made from your photo · 6 of 6", "5 of 6 from your photo,
 * 1 standard", "Standard". */
export function shapesLabel(t: Translate, view: ShapesView): string {
  if (view.kind === "own") return t("mouthShapesKind_own", { generated: view.generated, total: view.total });
  if (view.kind === "mixed") {
    return t("mouthShapesKind_mixed", {
      generated: view.generated,
      total: view.total,
      standard: view.total - view.generated,
    });
  }
  return t("mouthShapesKind_standard");
}

/** Why the shapes are no longer this photo's, for a dropped kit: its own
 * sentence (they were made for the previous picture…), or null. */
export function droppedText(t: Translate, view: ShapesView): string | null {
  if (view.kind !== "standard" || view.kit !== "dropped") return null;
  const code = view.dropped?.code;
  return code && oneOf(KIT_DROPPED_CODES, code) ? t(`mouthShapesDropped_${code}`) : null;
}

/** A shape the kit could not make, in a line: its name, and why. */
export function standardShapeText(t: Translate, shape: StandardShape): string {
  const name = t(`mouthShape_${shape.shape}`);
  return shape.reason ? t("mouthShapeStandardLine", { shape: name, reason: reasonText(t, shape.reason) }) : name;
}

/** Is there something of the person's own to compare with the standard
 * shapes? Some shapes made from the photo, and the draft's motion that
 * plays them. A kit with none of its own plays the standard shapes fitted
 * to the face: comparing that with the standard would compare nothing the
 * owner could name. */
export function canCompareShapes(mouth: Avatar["mouth"]): boolean {
  const view = shapesView(mouth);
  return Boolean(mouth?.motion_url) && (view?.kind === "own" || view?.kind === "mixed");
}

/**
 * Why the kit's teeth photo is not the avatar's, when the teeth on show do
 * not say so already, or null: the owner's own photo was kept (the kit
 * brought shapes only), the photo was removed since, or teeth an AI made
 * before were kept because the new photo could not be used. Standard teeth
 * with a note say it in the note.
 */
export function kitTeethReason(mouth: Avatar["mouth"], teeth: TeethView | null): Reason | null {
  const kit = mouth?.kit;
  if (!kit || kit.state !== "made" || kit.teeth?.used || !kit.teeth?.reason) return null;
  if (teeth?.kind === "generic" && teeth.note) return null;
  return kit.teeth.reason;
}

/** The kit's teeth reasons with a sentence of their own
 * (`mouthKitTeeth_<code>`); any other is "not used", with its reason
 * (reasonText; for a photo that failed a check, that check's). */
export const KIT_TEETH_CODES = ["owner_photo", "teeth_removed"] as const;

export function kitTeethText(t: Translate, reason: Reason): string {
  if (oneOf(KIT_TEETH_CODES, reason.code)) return t(`mouthKitTeeth_${reason.code}`);
  return t("mouthKitTeethNotUsed", { reason: reasonText(t, checkOf(reason)) });
}

/** The check a reason is about: a teeth photo that did not pass one names
 * it (`reason.reason`), when it has words here; else the reason itself. */
function checkOf(reason: Reason): Reason {
  const check = reason.code === "teeth_photo_rejected" ? reason.reason : null;
  return check && REASONS.has(check.code) ? check : reason;
}

/**
 * A teeth note in the owner's words: its own sentence
 * (`mouthTeethNote_<code>`, `noteKey`), and for a teeth photo that failed
 * a check, which check (`mouthTeethNote_teeth_photo_rejected_because`): the
 * lips too close is not the head moved. The server's sentence for a note
 * nothing here words.
 */
export function teethNoteText(t: Translate, note: Reason, noteKey: (code: string) => MessageKey | null): string {
  const check = checkOf(note);
  if (check !== note) return t("mouthTeethNote_teeth_photo_rejected_because", { reason: reasonText(t, check) });
  const key = noteKey(note.code);
  return key ? t(key) : `${t("mouthTeethGeneric")} ${note.detail}`;
}

// --- Reasons and failures -------------------------------------------------------------

/**
 * Why a shape is the standard one, or why none could be made: what stopped
 * the calls (the organization's switch, the limit, no image model), what
 * the AI answered, or which check its picture failed
 * (services.performance_kit). Each is a clause (`mouthReason_<code>`).
 */
export const SHAPE_REASON_CODES = [
  "safety_refused",
  "no_image",
  "provider_error",
  "timeout",
  "imagegen_unavailable",
  "image_limit_reached",
  "third_party_ai_disabled",
  "consent_not_recorded",
  "aspect_changed",
  "check_failed",
  "unreadable_result",
  "no_face_in_result",
  "mirrored",
  "head_moved",
  "registration",
  "nose_moved",
  "eyes_moved",
  "head_turned",
  "skin_tone_changed",
  "pose_not_reached",
] as const;

/** Every reason with a clause: a shape's, and why the kit's teeth photo is
 * not the avatar's (it shows too little of the upper teeth, or it did not
 * pass its checks). */
export const MOUTH_REASON_CODES = [...SHAPE_REASON_CODES, "mouth_teeth_unclear", "teeth_photo_rejected"] as const;

const SHAPE_REASONS: ReadonlySet<string> = new Set(SHAPE_REASON_CODES);
const REASONS: ReadonlySet<string> = new Set(MOUTH_REASON_CODES);

/** A reason in the owner's words, or the server's own when it has none. */
export function reasonText(t: Translate, reason: Reason | null): string {
  if (!reason) return "";
  return oneOf(MOUTH_REASON_CODES, reason.code) ? t(`mouthReason_${reason.code}`) : reason.detail;
}

// What the teeth alone can be refused for: worded as the teeth, since no
// shape was asked for (mouthErr_generate_<code>, mouthErr_<code>).
const TEETH_ALONE: ReadonlySet<string> = new Set([
  "safety_refused",
  "no_image",
  "provider_error",
  "timeout",
  "mouth_teeth_unclear",
  "reference_no_face",
  "reference_mouth_closed",
  "reference_face_small",
  "no_face_for_teeth",
  "face_turned",
  "landmarks_unavailable",
  "imagegen_unavailable",
  "image_limit_reached",
  "third_party_ai_disabled",
  "consent_not_recorded",
]);

/** A failed kit job's codes with a sentence of their own
 * (`mouthKitErr_<code>`). "interrupted" is the panel's own: its job is
 * gone. */
export const KIT_FAILURE_CODES = ["superseded", "job_failed", "interrupted"] as const;

/**
 * Why the panel's job failed, for the owner: its own sentence for a
 * failure of the job itself; "none of the mouth shapes could be made", and
 * why, when every shape stopped or failed its check; the mouth routes'
 * words otherwise (`errorKey`, teeth.mouthErrorKey on the AI's photo), as
 * for a refusal of the teeth alone. `teethAlone`: the job was last seen
 * making the teeth alone (where the server cannot make shapes), so a
 * refusal it shares with the shapes is worded as the teeth's. The server's
 * sentence when nothing here knows the code.
 */
export function kitFailureText(
  t: Translate,
  error: Reason,
  errorKey: (code: string) => MessageKey | null,
  teethAlone = false
): string {
  if (oneOf(KIT_FAILURE_CODES, error.code)) return t(`mouthKitErr_${error.code}`);
  const key = errorKey(error.code);
  if (teethAlone && key && TEETH_ALONE.has(error.code)) return t(key);
  if (SHAPE_REASONS.has(error.code)) return t("mouthKitErr_none", { reason: reasonText(t, error) });
  return key ? t(key) : error.detail || t("error");
}

// --- What step 5 gave the avatar ---------------------------------------------------------

/** Codes of a teeth note that stopped the whole mouth, shapes too: no AI
 * was allowed (the member's consent, the organization's switch, the image
 * model, the monthly limit), or the kit failed outright. */
export const WHOLE_MOUTH_CODES = [
  "no_ai_consent",
  "third_party_ai_disabled",
  "imagegen_unavailable",
  "image_limit_reached",
  "teeth_failed",
] as const;
const WHOLE_MOUTH: ReadonlySet<string> = new Set(WHOLE_MOUTH_CODES);

/**
 * What step 5 gave a person's mouth, for the avatar's page: where its
 * shapes come from, then its teeth (`teeth`, teeth.teethView). When
 * nothing was made for a reason that stopped both, one fact says it for
 * both ("standard teeth and mouth shapes: you had not agreed…"). Empty for
 * the classic mouth, which step 5 does not make.
 */
export type PreparedFact =
  { kind: "both_standard"; reason: Reason } | { kind: "shapes"; view: ShapesView } | { kind: "teeth"; view: TeethView };

export function preparedFacts(mouth: Avatar["mouth"], teeth: TeethView | null): PreparedFact[] {
  const shapes = shapesView(mouth);
  if (!shapes || !teeth) return [];
  const note = teeth.kind === "generic" ? teeth.note : null;
  if (shapes.kind === "standard" && shapes.kit === "none" && note && WHOLE_MOUTH.has(note.code)) {
    return [{ kind: "both_standard", reason: note }];
  }
  return [
    { kind: "shapes", view: shapes },
    { kind: "teeth", view: teeth },
  ];
}

/** Does a fact leave the mouth less than it could be (standard shapes or
 * teeth), so the owner is pointed to the Mouth panel? Some shapes of their
 * own and the rest standard counts: making them again may make all six. */
export function factWantsMore(fact: PreparedFact): boolean {
  if (fact.kind === "both_standard") return true;
  if (fact.kind === "shapes") return fact.view.kind !== "own";
  return fact.view.kind === "generic";
}

/** Does a fact need the owner's attention (the notice is then a warning,
 * not a summary)? Standard teeth, or no shape of the person's own. */
export function factNeedsAttention(fact: PreparedFact): boolean {
  if (fact.kind === "both_standard") return true;
  if (fact.kind === "shapes") return fact.view.kind === "standard";
  return fact.view.kind === "generic";
}

/**
 * A fact of step 5, in a sentence for the avatar's page: "Its own mouth
 * shapes: 5 of 6 made by AI from your photo, the rest standard.", "Its own
 * teeth, made by AI from your photo.", or standard ones and why (a teeth
 * note in its own words, `noteKey` being teeth.teethNoteKey; the server's
 * sentence for a note nothing here words).
 */
export function factText(t: Translate, fact: PreparedFact, noteKey: (code: string) => MessageKey | null): string {
  if (fact.kind === "both_standard") {
    // preparedFacts makes one for these codes only.
    const code = fact.reason.code;
    return oneOf(WHOLE_MOUTH_CODES, code) ? t(`finishNoticeStandard_${code}`) : reasonText(t, fact.reason);
  }
  if (fact.kind === "shapes") {
    const view = fact.view;
    if (view.kind === "own") return t("finishNoticeShapes_own", { total: view.total });
    if (view.kind === "mixed") return t("finishNoticeShapes_mixed", { generated: view.generated, total: view.total });
    const reason = view.standard.find((shape) => shape.reason)?.reason ?? null;
    if (view.kit === "made" && reason) return t("finishNoticeShapes_none", { reason: reasonText(t, reason) });
    return droppedText(t, view) ?? t("finishNoticeShapes_standard");
  }
  const view = fact.view;
  if (view.kind === "ai") return t("finishNoticeTeeth_ai");
  if (view.kind === "upload") return t("finishNoticeTeeth_upload");
  if (!view.note) return t("mouthTeethGeneric");
  return teethNoteText(t, view.note, noteKey);
}
