import type { MessageKey } from "@/i18n/types";
import type { Avatar, TeethRecord } from "@/lib/types";

/**
 * Whose teeth the photographic mouth shows, for the Mouth panel.
 *
 * A new person's avatar gets its own teeth made by AI when it is finished
 * (the teeth photo step 5 makes from their picture with the mouth shapes,
 * or alone where the server cannot make the shapes), or the standard teeth
 * with a note saying why not; an owner can also add their own photo. The
 * standard teeth are a photo too: the Reference avatar's own, the same for
 * every avatar without teeth of its own (kind "generic"). The server says
 * which in `mouth.teeth` (services.mouth_photo, mouth_kit).
 */
export type TeethView = { kind: "ai" } | { kind: "upload" } | { kind: "generic"; note: TeethRecord["note"] };

/** Why a new avatar has the standard teeth, by the note's code. Each has its
 * words (`mouthTeethNote_<code>`); a code not here shows the server's own
 * sentence. The kit's teeth photo not usable is its request's own reason,
 * `mouth_teeth_unclear`, or `teeth_photo_rejected` naming the check it
 * failed (mouth-kit.teethNoteText). `migrated_standard` is not a reason AI
 * made nothing: the avatar had the older drawn mouth and was moved onto the
 * photographic one with the standard teeth (backend
 * scripts/migrate_classic_mouths.py). */
export const TEETH_NOTE_CODES = [
  "no_ai_consent",
  "third_party_ai_disabled",
  "imagegen_unavailable",
  "image_limit_reached",
  "safety_refused",
  "no_image",
  "provider_error",
  "timeout",
  "consent_not_recorded",
  "mouth_teeth_unclear",
  "teeth_photo_rejected",
  "reference_no_face",
  "reference_mouth_closed",
  "reference_face_small",
  "no_face_for_teeth",
  "face_turned",
  "landmarks_unavailable",
  "teeth_failed",
  "migrated_standard",
] as const;

const KNOWN_NOTES: ReadonlySet<string> = new Set(TEETH_NOTE_CODES);
const isNoteCode = (code: string): code is (typeof TEETH_NOTE_CODES)[number] => KNOWN_NOTES.has(code);

/** The teeth of the photographic mouth, or null for the classic mouth
 * (whose teeth are drawn, and have nothing to say). */
export function teethView(mouth: Avatar["mouth"]): TeethView | null {
  if (!mouth || mouth.renderer !== "continuous") return null;
  const source = mouth.teeth?.source ?? (mouth.has_oral_photo ? "upload" : null);
  if (mouth.has_oral_photo && source === "ai") return { kind: "ai" };
  if (mouth.has_oral_photo) return { kind: "upload" };
  return { kind: "generic", note: mouth.teeth?.note ?? null };
}

/** The translation key for a note, or null to show its detail as sent. */
export function teethNoteKey(code: string): MessageKey | null {
  return isNoteCode(code) ? `mouthTeethNote_${code}` : null;
}

/** Codes of the warnings finishing a creation can return (FinishResult). */
export const FINISH_WARNINGS = ["mouth_open", "teeth_showing"] as const;

/** Words for the teeth in use, by kind (`mouthTeethKind_<kind>`). */
export const TEETH_KINDS = ["ai", "upload", "generic"] as const;

/** Refusals about the mouth photo itself, which read differently when it
 * is the owner's upload ("your photo") or the AI's ("the AI's photo", the
 * teeth alone the Mouth panel's job makes where the server cannot make the
 * shapes): `mouthErr_<action>_<code>`. */
export const MOUTH_PHOTO_CODES = [
  "mouth_teeth_unclear",
  "reference_no_face",
  "reference_mouth_closed",
  "reference_face_small",
] as const;

/** Every other refusal of the mouth routes (POST …/mouth-photo, POST
 * …/mouth-kit) and failure of the teeth alone, with words of its own:
 * `mouthErr_<code>`. A code not here shows the server's sentence.
 * consent_required never reaches the panel: useConsent.withAi asks again
 * instead. */
export const MOUTH_ERROR_CODES = [
  "third_party_ai_disabled",
  "imagegen_unavailable",
  "image_limit_reached",
  "safety_refused",
  "no_image",
  "provider_error",
  "timeout",
  "consent_not_recorded",
  "no_face_for_teeth",
  "face_turned",
  "landmarks_unavailable",
  "not_a_photo",
  "source_gone",
  "avatar_not_found",
  "mouth_not_for_face_type",
  "unsupported_image_type",
  "image_too_large",
  "consent_outdated",
  "too_many_jobs",
  "job_queue_full",
] as const;

const PHOTO_CODES: ReadonlySet<string> = new Set(MOUTH_PHOTO_CODES);
const ERROR_CODES: ReadonlySet<string> = new Set(MOUTH_ERROR_CODES);
const isPhotoCode = (code: string): code is (typeof MOUTH_PHOTO_CODES)[number] => PHOTO_CODES.has(code);
const isErrorCode = (code: string): code is (typeof MOUTH_ERROR_CODES)[number] => ERROR_CODES.has(code);

/** Who made the mouth photo a refusal is about: the owner's upload, or the
 * AI (the teeth alone, in the Mouth panel's job). */
export type MouthAction = "upload" | "generate";

/** The translation key for a refused mouth photo, or null to show the
 * server's own sentence. */
export function mouthErrorKey(code: string, action: MouthAction): MessageKey | null {
  if (isPhotoCode(code)) return `mouthErr_${action}_${code}`;
  return isErrorCode(code) ? `mouthErr_${code}` : null;
}

/**
 * The disclosure an avatar carries, as translation keys: what the AI did to
 * the picture, then "AI teeth" when the teeth photo was made by AI as well
 * (`ai_edited.teeth`), then "AI mouth shapes" when some of the mouth shapes
 * were (`ai_edited.mouth_shapes`). Each is said once: on its own, it is
 * the mode. Visitors are told the same, from the published snapshot.
 */
export function aiEditedLabels(edited: Avatar["ai_edited"]): MessageKey[] {
  if (!edited) return [];
  const keys: MessageKey[] = [`aiEdited_${edited.mode}`];
  if (edited.teeth && edited.mode !== "teeth") keys.push("aiEdited_teeth");
  if (edited.mouth_shapes && edited.mode !== "mouth_shapes") keys.push("aiEdited_mouth_shapes");
  return keys;
}

/** The models behind the disclosure, each once, for its tooltip. */
export function aiEditedModels(edited: Avatar["ai_edited"]): string[] {
  if (!edited) return [];
  const models = [edited.model, edited.teeth?.model, edited.mouth_shapes?.model].filter((m): m is string => Boolean(m));
  return [...new Set(models)];
}
