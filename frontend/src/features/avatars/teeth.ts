import type { Avatar, TeethRecord } from "@/lib/types";

/**
 * Whose teeth the photographic mouth shows, for the Mouth panel.
 *
 * A new person's avatar gets its own teeth made by AI when it is finished
 * (an "ee" photo of the person, from their picture), or generic teeth with
 * a note saying why not; an owner can also add their own photo. The server
 * says which in `mouth.teeth` (services.mouth_photo).
 */
export type TeethView =
  | { kind: "ai" }
  | { kind: "upload" }
  | { kind: "generic"; note: TeethRecord["note"] };

/** Why a new avatar has generic teeth, by the note's code. Each has its
 * words (`mouthTeethNote_<code>`); a code not here shows the server's own
 * sentence. */
export const TEETH_NOTE_CODES = [
  "no_ai_consent",
  "third_party_ai_disabled",
  "imagegen_unavailable",
  "image_limit_reached",
  "safety_refused",
  "no_image",
  "provider_error",
  "mouth_teeth_unclear",
  "reference_no_face",
  "reference_mouth_closed",
  "reference_face_small",
  "no_face_for_teeth",
  "face_turned",
  "landmarks_unavailable",
  "teeth_failed",
] as const;

const KNOWN_NOTES: ReadonlySet<string> = new Set(TEETH_NOTE_CODES);

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
export function teethNoteKey(code: string): string | null {
  return KNOWN_NOTES.has(code) ? `mouthTeethNote_${code}` : null;
}

/** Codes of the warnings finishing a creation can return (FinishResult). */
export const FINISH_WARNINGS = ["mouth_open", "teeth_showing"] as const;

/** Words for the teeth in use, by kind (`mouthTeethKind_<kind>`). */
export const TEETH_KINDS = ["ai", "upload", "generic"] as const;

/** Refusals about the mouth photo itself, which read differently when it
 * is the owner's upload ("your photo") or the AI's ("the AI's photo"):
 * `mouthErr_<action>_<code>`. */
export const MOUTH_PHOTO_CODES = [
  "mouth_teeth_unclear",
  "reference_no_face",
  "reference_mouth_closed",
  "reference_face_small",
] as const;

/** Every other refusal of the teeth routes (POST …/mouth-photo and
 * …/mouth-photo/generate) with words of its own: `mouthErr_<code>`. A code
 * not here shows the server's sentence. consent_required never reaches the
 * panel: useConsent.withAi asks again instead. */
export const MOUTH_ERROR_CODES = [
  "third_party_ai_disabled",
  "imagegen_unavailable",
  "image_limit_reached",
  "safety_refused",
  "no_image",
  "provider_error",
  "no_face_for_teeth",
  "face_turned",
  "landmarks_unavailable",
  "teeth_in_progress",
  "not_a_photo",
  "source_gone",
  "mouth_not_for_face_type",
  "unsupported_image_type",
  "image_too_large",
  "consent_outdated",
] as const;

const PHOTO_CODES: ReadonlySet<string> = new Set(MOUTH_PHOTO_CODES);
const ERROR_CODES: ReadonlySet<string> = new Set(MOUTH_ERROR_CODES);

export type MouthAction = "upload" | "generate";

/** The translation key for a refused mouth photo, or null to show the
 * server's own sentence. */
export function mouthErrorKey(code: string, action: MouthAction): string | null {
  if (PHOTO_CODES.has(code)) return `mouthErr_${action}_${code}`;
  return ERROR_CODES.has(code) ? `mouthErr_${code}` : null;
}

/**
 * The disclosure an avatar carries, as translation keys: what the AI did to
 * the picture, then "AI teeth" when the teeth photo was made by AI as well
 * (`ai_edited.teeth`; on its own the mode is "teeth"). Visitors are told
 * the same, from the published snapshot.
 */
export function aiEditedLabels(edited: Avatar["ai_edited"]): string[] {
  if (!edited) return [];
  const keys = [`aiEdited_${edited.mode}`];
  if (edited.teeth && edited.mode !== "teeth") keys.push("aiEdited_teeth");
  return keys;
}

/** The models behind the disclosure, each once, for its tooltip. */
export function aiEditedModels(edited: Avatar["ai_edited"]): string[] {
  if (!edited) return [];
  const models = [edited.model, edited.teeth?.model].filter((m): m is string => Boolean(m));
  return [...new Set(models)];
}
