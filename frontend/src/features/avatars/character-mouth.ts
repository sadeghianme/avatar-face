/**
 * The character mouth's settings, without a browser: `npm test` (node --test).
 *
 * An animation or an animal talks with a drawn or rendered opening, a tongue
 * and (for a toon) teeth, instead of the classic mouth (docs/avatar-lines.md,
 * "Embed engine"). Which one an avatar has is on its rig (`render_profile`);
 * how the character mouth is set is the owner's, saved as `mouth.character`.
 * Avatars made before it keep their original mouth until the owner chooses it
 * here or marks the face again.
 */
import type { CharacterSettings } from "@liveface/embed/mouth";

/** The profiles that move and paint the mouth as a character's. */
const CHARACTER_PROFILES: readonly string[] = ["toon@1", "animal@2"];

/** Ranges mirror TRAIT_LIMITS in the embed and CharacterUpdate in the API. */
export const JAW_LIMITS = { min: 0.5, max: 1.6, step: 0.05 } as const;

export type MouthLook = "character" | "original";

/**
 * Which look the avatar has now: null for a face that has no choice (a
 * person's keeps the classic and the photographic mouths), else the
 * character mouth when its rig names one, or the original.
 */
export function mouthLook(avatar: {
  face_type?: string;
  kind?: string;
  render_profile?: string | null;
}): MouthLook | null {
  if ((avatar.face_type ?? "human") === "human" || avatar.kind === "model3d") return null;
  return avatar.render_profile && CHARACTER_PROFILES.includes(avatar.render_profile) ? "character" : "original";
}

/** A complete setting from what was saved: what the API stores, with the
 *  defaults the engine uses for what was not. */
export function characterSettings(saved: CharacterSettings | null | undefined): Required<CharacterSettings> {
  const jaw = typeof saved?.jaw === "number" && Number.isFinite(saved.jaw) ? saved.jaw : 1;
  return {
    style: saved?.style === "classic" ? "classic" : "character",
    teeth: saved?.teeth === "none" ? "none" : "upper",
    tongue: saved?.tongue !== false,
    jaw: Math.max(JAW_LIMITS.min, Math.min(JAW_LIMITS.max, jaw)),
  };
}

/** What to send the API: the settings, with the style the owner is choosing. */
export function characterUpdate(
  settings: Required<CharacterSettings>,
  style: "character" | "classic" = settings.style
): Required<CharacterSettings> {
  return { ...settings, style, jaw: Math.round(settings.jaw * 100) / 100 };
}

/**
 * Whether a mouth style choice is a change: the original mouth is the style
 * of a rig that names no character profile, and choosing it when that is
 * what the avatar has is nothing to save.
 */
export function styleChange(look: MouthLook | null, next: "character" | "classic"): boolean {
  if (look === null) return false;
  return (look === "character") !== (next === "character");
}
