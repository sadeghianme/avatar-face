/**
 * The four-step creation wizard: 1 Model · 2 Photo · 3 Prepare · 4 Publish
 * (the owner's flow, docs/avatar-lines.md "The creation flow"), as rules.
 *
 * 1 Model    a human avatar or an animal avatar;
 * 2 Photo    "Generate with AI" (one description) or "Upload a photo", in a
 *            look: Realistic, Animation (3D, animated-film) or Cartoon (flat
 *            2D); the consent and, for a person, the statement, here;
 * 3 Prepare  automatic: the background comes off and the AI makes the
 *            picture in the look, ready to speak (services.wizard); Retry,
 *            "describe a change", and for a realistic upload "use my
 *            original photo"; every version is kept and any can be taken
 *            back (POST /version);
 * 4 Publish  the face found by itself, its points on the picture to drag
 *            if one is off, a talking preview, Publish; a person's own
 *            mouth is made while it publishes.
 *
 * Steps 1 and 2 are this page's state (the URL's `?model=`); from step 3 on
 * there is a creation, whose `plan` says what was chosen. Framework-free
 * with type-only imports, tested with `node --test`.
 */
import type { FaceStatement } from "@/features/avatars/consent";
import type {
  Creation,
  CreationAnchors,
  CreationJob,
  CreationStep,
  DraftStore,
  StepId,
} from "@/features/avatars/creation";
import type { FaceType } from "@/lib/types";

export type AvatarModel = "human" | "animal";
export type Look = "realistic" | "animation" | "cartoon";
export type PhotoSource = "generate" | "upload";
export type Screen = "model" | "photo" | "prepare" | "publish";

export const SCREENS: readonly Screen[] = ["model", "photo", "prepare", "publish"];
export const MODELS: readonly AvatarModel[] = ["human", "animal"];
export const LOOKS: readonly Look[] = ["realistic", "animation", "cartoon"];
export const SOURCES: readonly PhotoSource[] = ["generate", "upload"];
/** The server's limit on a description or a change (services.wizard). */
export const MAX_WORDS = 300;

export interface Plan {
  model: AvatarModel;
  look: Look;
  source: PhotoSource;
  description: string | null;
}

/** What the prepare job last did (`ai.last_prepare`). */
export interface LastPrepare {
  mode: "ai" | "change" | "generate" | "original";
  look: Look;
  instruction: string | null;
  step: string;
  /** False when the background could not be taken off cleanly. */
  cut: boolean;
}

/** The creation fields this module reads beyond creation.ts's. */
export type WizardCreation = Creation & {
  plan?: Plan | null;
  ai: Creation["ai"] & { prepare_rounds_left?: number; free_clears_left?: number; last_prepare?: LastPrepare | null };
};

/** Model × look → the line the avatar is rigged and rendered on
 * (services.wizard.line_for): a realistic person is the human line (the
 * photographic mouth, and their own mouth kit at publish), a realistic
 * animal the animal line (the muzzle), anything animated or drawn the
 * cartoon line. */
export function lineFor(model: AvatarModel, look: Look): FaceType {
  if (look === "realistic") return model === "animal" ? "animal" : "human";
  return "cartoon";
}

export function parseModel(value: string | null | undefined): AvatarModel | null {
  return MODELS.find((m) => m === value) ?? null;
}

export function parseLook(value: string | null | undefined): Look | null {
  return LOOKS.find((l) => l === value) ?? null;
}

/** The creation's plan: the server's, or for a creation the old wizard
 * started, the one its line implies (as the server infers it). */
export function planOf(creation: WizardCreation): Plan {
  if (creation.plan) return creation.plan;
  const generated = Boolean(creation.steps.find((s) => s.id === "original")?.generated);
  return {
    model: creation.face_type === "animal" ? "animal" : "human",
    look: creation.face_type === "cartoon" ? "cartoon" : "realistic",
    source: generated ? "generate" : "upload",
    description: null,
  };
}

// --- Step 2: what is asked ------------------------------------------------------------

/** Must the owner agree to the AI to go on? Always, but for a realistic
 * upload, which can use the photo as it is (cut out, no AI). */
export function aiRequired(source: PhotoSource, look: Look): boolean {
  return source === "generate" || look !== "realistic";
}

/** The statement about a face expected with the photo or the description,
 * before the server has looked at anything: a person's photo is someone
 * ("I am this person or have their permission"), a person made from words
 * is no one real. An animal is not expected to need either. This is only a
 * forecast: what finishing really needs is the server's word
 * (`Creation.statement`, from where the pixels came from and what the photo
 * check found), which only exists once there is a creation. An uploaded
 * animal's photo may turn out to show a person, a generated character's
 * face is only known after Prepare. `statementToAsk` is the truth. */
export function statementFor(model: AvatarModel, source: PhotoSource): FaceStatement | null {
  if (model !== "human") return null;
  return source === "upload" ? "depiction" : "generated_face";
}

/**
 * The statement Publish must show the member now: the one the server says
 * finishing needs for this creation, unless the member already made it with
 * the photo (`made`, remembered by this tab). The server's word, never the
 * model's: a cartoon dog the face detector took for a face, an animal photo
 * that is really a person, a character whose face was found only on
 * Prepare, all need (or do not need) a statement the Photo screen could not
 * know. A server that does not say yet is taken to ask it of a person.
 */
export function statementToAsk(
  creation: Pick<Creation, "statement" | "face_type">,
  made: FaceStatement | null
): FaceStatement | null {
  const needed =
    creation.statement !== undefined ? creation.statement : (creation.face_type ?? "human") === "human" ? "depiction" : null;
  return needed && needed !== made ? needed : null;
}

export interface PhotoForm {
  model: AvatarModel;
  source: PhotoSource;
  look: Look;
  description: string;
  hasFile: boolean;
  aiAgreed: boolean;
  statementAgreed: boolean;
  /** The organization allows third-party AI. */
  aiEnabled: boolean;
}

/** Why "Create my avatar" is held, as an i18n key, or null when it may go. */
export function photoBlocker(form: PhotoForm): string | null {
  if (!form.aiEnabled && aiRequired(form.source, form.look)) return "wzHoldAiOff";
  if (form.source === "upload" && !form.hasFile) return "wzHoldFile";
  if (form.source === "generate" && !form.description.trim()) return "wzHoldDescription";
  if (aiRequired(form.source, form.look) && !form.aiAgreed) return "wzHoldAi";
  if (statementFor(form.model, form.source) && !form.statementAgreed) return "wzHoldStatement";
  return null;
}

/** How step 3 starts a new upload: the AI in the look, or (a realistic
 * upload whose owner did not agree to the AI) the photo itself. */
export type PrepareIntent = "ai" | "original";

export function intentFor(form: Pick<PhotoForm, "source" | "look" | "aiAgreed" | "aiEnabled">): PrepareIntent {
  return form.aiAgreed && form.aiEnabled ? "ai" : "original";
}

// --- Step 3 ---------------------------------------------------------------------------

const PREPARE_STEPS: ReadonlySet<string> = new Set(["ingest", "generate", "prepare", "background", "detect"]);

/** Is `job` part of making the picture (step 3's work)? */
export function isPrepareJob(job: CreationJob | null | undefined): boolean {
  return Boolean(job && PREPARE_STEPS.has(job.step));
}

/** Where step 3's work is, for the words under the progress bar. */
export type PrepareStage = "queued" | "upload" | "create" | "check" | "background" | "face" | "save";

// The labels services.creations and services.wizard report (job.report).
// A label this does not know shows the step's general words, never a wrong
// stage.
const STAGE_OF_LABEL: Readonly<Record<string, PrepareStage>> = {
  reading: "upload",
  analysing: "check",
  generating: "create",
  "preparing the photo": "upload",
  "creating your avatar": "create",
  "checking the picture": "check",
  "removing the background": "background",
  "finding the face": "face",
  "asking the AI for the points": "face",
  "checking the points": "face",
  saving: "save",
};

export function prepareStage(job: CreationJob | null | undefined): PrepareStage | null {
  if (!job || !isPrepareJob(job)) return null;
  if (job.state === "queued") return "queued";
  if (job.state !== "running") return null;
  const label = job.progress?.label;
  if (!label) return job.step === "generate" || job.step === "prepare" ? "create" : "upload";
  return STAGE_OF_LABEL[label] ?? null;
}

const STAGE_RANK: Readonly<Record<PrepareStage, number>> = {
  queued: 0,
  upload: 1,
  create: 2,
  check: 3,
  background: 4,
  face: 5,
  save: 6,
};

/**
 * The stage to show: never one earlier than a stage already shown in this
 * run. A try is several requests and jobs in a row (the upload's reading,
 * then the picture's job, which waits for a slot first), and polls land in
 * any order against them: left alone, the words went "Reading your photo"
 * → "Waiting for a free spot" → "Reading…" within one try. `held` is the
 * stage shown so far in this run (null when none; a run ends when nothing
 * is working, and the next one starts afresh).
 */
export function heldStage(held: PrepareStage | null, next: PrepareStage | null): PrepareStage | null {
  if (next === null) return held;
  if (held === null) return next;
  return STAGE_RANK[next] >= STAGE_RANK[held] ? next : held;
}

/** The checklist row a stage lights: the checking of the picture is still
 * making it, and saving is the end of finding the face. */
export function checklistRow(stage: PrepareStage | null, rows: readonly PrepareStage[]): number {
  if (stage === null || stage === "queued") return -1;
  const own = rows.indexOf(stage);
  if (own >= 0) return own;
  const row = stage === "check" ? "create" : stage === "save" ? "face" : null;
  return row ? rows.indexOf(row) : -1;
}

/** The ordered stages step 3 shows as a checklist, for the work at hand. */
export function prepareChecklist(source: PhotoSource, withAi: boolean): PrepareStage[] {
  if (source === "generate") return ["create", "background", "face"];
  return withAi ? ["upload", "create", "background", "face"] : ["upload", "background", "face"];
}

/** The picture the avatar will be made of: the current image, once step 3
 * has made it (the anchors found on it are what says so). */
export function preparedStep(creation: Creation): CreationStep | null {
  const anchors = creation.anchors;
  if (!anchors || anchors.image === null) return null;
  const current = creation.steps.find((s) => s.id === creation.current) ?? null;
  if (!current) return null;
  // The anchors belong to the current image or to the one it was cut from.
  const behind = current.from ? creation.steps.find((s) => s.id === current.from) : null;
  const ownFrame = anchors.image === current.id || (Boolean(current.cutout) && anchors.image === behind?.id);
  return ownFrame ? current : null;
}

/** The "before" of the before/after: the upload, for an uploaded photo. A
 * character made from words has none. */
export function beforeStep(creation: WizardCreation): CreationStep | null {
  if (planOf(creation).source !== "upload") return null;
  return creation.steps.find((s) => s.id === "original") ?? null;
}

/** Should step 3 start preparing by itself? The photo is in, nothing runs
 * or failed, and nothing is prepared yet. */
export function needsPrepare(creation: WizardCreation): boolean {
  if (creation.status !== "draft") return false;
  if (!creation.steps.some((s) => s.id === "original") || !creation.face_type) return false;
  const job = creation.job;
  if (job && (job.state === "queued" || job.state === "running")) return false;
  if (job && (job.state === "failed" || job.state === "interrupted") && job.error?.code !== "superseded") {
    return false;
  }
  return preparedStep(creation) === null;
}

/** Where step 3 is: working on the picture, done (a picture is ready,
 * even when a later try failed: it is still there), failed with nothing
 * to show, or waiting to start (about to, or for the owner's agreement). */
export type PreparePhase = "working" | "done" | "failed" | "waiting";

export function preparePhase(creation: Creation): PreparePhase {
  const job = creation.job;
  if (isBusyPreparing(creation)) return "working";
  if (preparedStep(creation)) return "done";
  if (job && isPrepareJob(job) && (job.state === "failed" || job.state === "interrupted") && job.error?.code !== "superseded") {
    return "failed";
  }
  return "waiting";
}

/** The body of POST /prepare. */
export interface PrepareBody {
  mode: "ai" | "change" | "generate" | "original";
  instruction?: string;
  /** With `change`: Retry of the last change (from the same base). */
  again?: boolean;
  /** With `ai` or `generate`: "Remove this change". Costs no try while the
   * creation's few free ones last (the server decides), still one image call. */
  clear?: boolean;
}

/** The change in effect: the owner's last instruction, when the last try
 * was a change. */
export function activeChange(last: LastPrepare | null | undefined): string | null {
  return last?.mode === "change" && last.instruction ? last.instruction : null;
}

/** The plain try: the upload redone in its look, or a described character
 * made anew, with no change in effect. */
export function plainBody(plan: Plan): PrepareBody {
  return { mode: plan.source === "generate" ? "generate" : "ai" };
}

/** "Remove this change": the plain try, asked as a removal so it gives its
 * try back. */
export function clearBody(plan: Plan): PrepareBody {
  return { ...plainBody(plan), clear: true };
}

/** Removals that still cost no try (three per creation). */
export function freeClearsLeft(creation: WizardCreation): number {
  return creation.ai?.free_clears_left ?? 0;
}

/** What Retry asks: "try again" means the same request. When the last try
 * was a change, that change again on the same base (the instruction stays
 * in effect until the owner clears it); otherwise the plain try. Each is
 * one of the six tries. */
export function retryBody(plan: Plan, last: LastPrepare | null | undefined): PrepareBody {
  const change = activeChange(last);
  return change ? { mode: "change", instruction: change, again: true } : plainBody(plan);
}

/** "Use my original photo": a realistic upload only. */
export function canUseOriginal(plan: Plan): boolean {
  return plan.source === "upload" && plan.look === "realistic";
}

/** AI tries left on step 3 (six per creation). */
export function triesLeft(creation: WizardCreation): number {
  return creation.ai?.prepare_rounds_left ?? 0;
}

// --- Step 3: every version kept --------------------------------------------------------

/** A picture made on step 3, kept to go back to (POST /version): the upload
 * ("original") or an AI result ("adjusted:N"), each with its cut-out. */
export type VersionKind = "photo" | "ai" | "change" | "generated";

export interface Version {
  /** "original" or "adjusted:N": what POST /version takes. */
  id: StepId;
  /** 1-based, in the strip's order. */
  number: number;
  kind: VersionKind;
  /** The owner's words, on a change. */
  instruction: string | null;
  /** The picture to show for it: its cut-out when it has one. */
  shown: CreationStep;
  /** Can it be the picture used? Not the upload of a stylised plan (the
   * avatar is made of the AI's picture), not a result that failed its checks. */
  selectable: boolean;
  /** An upload "use my original photo" has not prepared yet: choosing it
   * prepares it (no AI) rather than switching to it. */
  needsPrepare: boolean;
}

const ADJUSTED = "adjusted:";

function adjustedNumber(id: string): number | null {
  if (!id.startsWith(ADJUSTED)) return null;
  const tail = id.slice(ADJUSTED.length);
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

/** The version the image `stepId` belongs to: a cut-out is its source's,
 * the upload's framing is the upload's. */
export function versionOfStep(creation: Pick<Creation, "steps">, stepId: string | null | undefined): StepId | null {
  const byId = new Map(creation.steps.map((s) => [s.id as string, s]));
  let id = stepId ?? null;
  const seen = new Set<string>();
  while (id && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    if (id === "original" || adjustedNumber(id) !== null) return id as StepId;
    if (id === "framed") return "original";
    // A cut-out ("cutout", "cutout:N") is the version it was cut from.
    const step = byId.get(id)!;
    if (!step.cutout || !step.from) return null;
    id = step.from;
  }
  return null;
}

/** Every version, the upload first, then each AI result in the order made
 * (newest last). A character made from words has no upload: its first
 * picture is the AI's. */
export function versionsOf(creation: WizardCreation): Version[] {
  const plan = planOf(creation);
  const byId = new Map(creation.steps.map((s) => [s.id as string, s]));
  const cutOf = (id: string): CreationStep | null => {
    const n = adjustedNumber(id);
    const cut = byId.get(n === null ? "cutout" : `cutout:${n}`);
    return cut && cut.from === id ? cut : null;
  };
  const out: Version[] = [];
  const original = byId.get("original");
  if (original) {
    const upload = plan.source === "upload";
    const framed = upload ? byId.get("framed") ?? null : null;
    const base = framed ?? original;
    const cut = cutOf(base.id);
    const last = (creation.ai?.last_prepare ?? null) as LastPrepare | null;
    const prepared = !upload || Boolean(framed || cut || last?.mode === "original");
    out.push({
      id: "original",
      number: 0,
      kind: upload ? "photo" : "generated",
      instruction: null,
      shown: prepared ? cut ?? base : original,
      selectable: !upload || canUseOriginal(plan),
      needsPrepare: upload && canUseOriginal(plan) && !prepared,
    });
  }
  const made = creation.steps
    .filter((s) => adjustedNumber(s.id) !== null && !s.adjust?.rejected)
    .sort((a, b) => adjustedNumber(a.id)! - adjustedNumber(b.id)!);
  for (const step of made) {
    const adjust = (step.adjust ?? null) as (CreationStep["adjust"] & { instruction?: string | null }) | null;
    const instruction = adjust?.instruction?.trim() || null;
    out.push({
      id: step.id,
      number: 0,
      kind: instruction ? "change" : "ai",
      instruction,
      shown: cutOf(step.id) ?? step,
      selectable: true,
      needsPrepare: false,
    });
  }
  return out.map((v, i) => ({ ...v, number: i + 1 }));
}

/** The version in use: the current picture's, once step 3 has made one. */
export function selectedVersion(creation: WizardCreation): StepId | null {
  return preparedStep(creation) ? versionOfStep(creation, creation.current) : null;
}

/** The words that name a version (its alt text), as an i18n key and its
 * values: "Version 3: change “shorter hair”". */
export function versionLabel(version: Pick<Version, "number" | "kind" | "instruction">): {
  key: string;
  values: Record<string, string | number>;
} {
  return {
    key: `wzVersionAlt_${version.kind}`,
    values: { n: version.number, change: version.instruction ?? "" },
  };
}

// --- The footer -------------------------------------------------------------------------

/** What the wizard's fixed footer offers on each screen: Back on the left
 * (where it goes), the screen's one primary action on the right. */
export interface FooterPlan {
  back: "avatars" | "model" | "photo" | "prepare" | null;
  primary: "create" | "continue" | "publish" | null;
}

export function footerPlan(
  screen: Screen,
  state: { prepared?: boolean; building?: boolean } = {}
): FooterPlan {
  switch (screen) {
    case "model":
      return { back: "avatars", primary: null };
    case "photo":
      return { back: "model", primary: "create" };
    case "prepare":
      return { back: "photo", primary: state.prepared ? "continue" : null };
    case "publish":
      return state.building ? { back: null, primary: null } : { back: "prepare", primary: "publish" };
  }
}

// --- Step 4 ---------------------------------------------------------------------------

/** The screen a creation is on: a creation being built or built is on
 * Publish; Publish is asked for (`?step=publish`) and the picture is ready;
 * otherwise Prepare. Asking for Publish never skips making the picture. */
export function screenFor(creation: WizardCreation, requested: string | null): "prepare" | "publish" {
  if (creation.status === "finishing" || creation.status === "finished") return "publish";
  if (requested === "publish" && preparedStep(creation) && !isBusyPreparing(creation)) return "publish";
  return "prepare";
}

function isBusyPreparing(creation: Creation): boolean {
  const job = creation.job;
  return Boolean(job && isPrepareJob(job) && (job.state === "queued" || job.state === "running"));
}

/** Were the eyes, lips and head found, well enough to publish without
 * placing a point? A detection the validator passes, or the vision
 * model's points (an animal, a drawing) that fit. A template's guess is
 * not: then the points editor opens. */
export function faceFound(anchors: Pick<CreationAnchors, "detected" | "source" | "validation"> | null): boolean {
  if (!anchors) return false;
  return anchors.validation.ok && (anchors.detected || anchors.source === "ai");
}

// --- Names ----------------------------------------------------------------------------

// Camera and app file names say nothing about who is in the picture.
const MEANINGLESS_FILE =
  /^(img|image|dsc|dscn|dscf|pxl|photo|picture|pic|screenshot|screen shot|capture|whatsapp|signal|telegram|mvimg|received|download|untitled|p)(?=$|[\W_\d])|^[\d\W_]+$|\d{6,}/i;
const ARTICLES = /^(a|an|the|un|une|le|la|les|des|l')\s+/i;
const NAME_MAX = 40;

function capitalised(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  return (space > max / 2 ? head.slice(0, space) : text.slice(0, max)).trim();
}

/**
 * A sensible first name for a new avatar (renamed on its page in one
 * click): the description's own words ("a cheerful baker with flour on her
 * apron" → "Cheerful baker with flour on her"), a file name that means
 * something ("maria_headshot.jpg" → "Maria headshot"), else `fallback` (the
 * model and look in words, "Realistic human").
 */
export function defaultName(input: { description?: string | null; fileName?: string | null; fallback: string }): string {
  const words = (input.description ?? "").replace(/\s+/g, " ").trim().replace(ARTICLES, "");
  if (words) return capitalised(cut(words.replace(/[.,;:!?]+$/, ""), NAME_MAX));
  const stem = (input.fileName ?? "").replace(/\.[^.]+$/, "").trim();
  if (stem && !MEANINGLESS_FILE.test(stem)) {
    const clean = stem.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
    if (clean) return capitalised(cut(clean, NAME_MAX));
  }
  return input.fallback;
}

// --- This tab's memory ----------------------------------------------------------------

/** What step 2 was given, kept for this tab: going Back from step 3 opens
 * step 2 as it was, and step 3 knows how to start and what to call it. */
export interface Choices {
  model: AvatarModel;
  source: PhotoSource;
  look: Look;
  description: string;
  fileName: string | null;
  intent: PrepareIntent;
  /** The statement about the face the member made on step 2, if any. */
  statement: FaceStatement | null;
}

const CHOICES_PREFIX = "liveface.wizard.";
const LAST_KEY = `${CHOICES_PREFIX}last`;

export function rememberChoices(store: DraftStore | null, creationId: string | null, choices: Choices): void {
  try {
    const text = JSON.stringify(choices);
    store?.setItem(LAST_KEY, text);
    if (creationId) store?.setItem(`${CHOICES_PREFIX}${creationId}`, text);
  } catch {
    // best effort: without it step 3 goes by the plan
  }
}

function parseChoices(raw: string | null | undefined): Choices | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Choices> | null;
    const model = parseModel(value?.model);
    const look = parseLook(value?.look);
    const source = SOURCES.find((s) => s === value?.source) ?? null;
    if (!model || !look || !source) return null;
    return {
      model,
      look,
      source,
      description: typeof value?.description === "string" ? value.description.slice(0, MAX_WORDS) : "",
      fileName: typeof value?.fileName === "string" ? value.fileName : null,
      intent: value?.intent === "original" ? "original" : "ai",
      statement: value?.statement === "depiction" || value?.statement === "generated_face" ? value.statement : null,
    };
  } catch {
    return null;
  }
}

/** The choices kept for a creation, or (no id) the last ones made. */
export function recallChoices(store: DraftStore | null, creationId: string | null): Choices | null {
  try {
    return parseChoices(store?.getItem(creationId ? `${CHOICES_PREFIX}${creationId}` : LAST_KEY));
  } catch {
    return null;
  }
}

export function forgetChoices(store: DraftStore | null, creationId: string): void {
  try {
    store?.removeItem(`${CHOICES_PREFIX}${creationId}`);
  } catch {
    // best effort
  }
}
