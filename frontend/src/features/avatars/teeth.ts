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
