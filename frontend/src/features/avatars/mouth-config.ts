/**
 * The mouth config the dashboard previews, built from what the API returns.
 *
 * The preview must play what visitors get (attachAvatarMouth's promise): the
 * owner's dashboard and the public share page reach the same loader as the
 * widget, so every field the widget hands on must reach it here too. That
 * includes `motion_url`, the avatar's own performance manifest (its six
 * mouth shapes, made by the backend's performance kit): dropped, the preview
 * plays the bundled Reference motion at a different movement scale, and the
 * owner tunes a mouth nobody else sees.
 *
 * Framework-free with type-only imports, like consent.ts, so the rules are
 * tested with `node --test`.
 */
import type { AvatarMouthConfig } from "@liveface/embed/mouth";
import type { FaceType, MouthRenderer } from "@/lib/types";

/** A presigned URL is re-signed on every fetch: what it names is its path. */
export function urlIdentity(url: string | null | undefined): string | null {
  return url ? url.split("?")[0] : null;
}

/**
 * When the attached mouth must be rebuilt: the renderer, the teeth photo or
 * the motion changed. Not the profile, which is applied live, and not a
 * fresh signature on the same files.
 */
export function mouthLoadIdentity(config: AvatarMouthConfig | null): string {
  if (config?.renderer !== "continuous") return "classic";
  return JSON.stringify([urlIdentity(config.oral?.image_url), urlIdentity(config.motion_url)]);
}

/** The config to load, from the freshest copy (current signatures). */
export function mouthConfigToLoad(config: AvatarMouthConfig | null): AvatarMouthConfig {
  const image = config?.oral?.image_url, rig = config?.oral?.rig_url;
  return {
    renderer: "continuous",
    profile: config?.profile,
    oral: image && rig ? { image_url: image, rig_url: rig } : null,
    motion_url: config?.motion_url ?? null,
  };
}

/** What the owner API says about an avatar's draft mouth. */
export interface DraftMouthSource {
  face_type?: FaceType;
  mouth_photo?: { image_url: string; rig_url: string } | null;
  mouth?: { renderer: MouthRenderer; profile: Record<string, number>; motion_url?: string | null } | null;
}

/**
 * The draft mouth to preview with `renderer` and `profile` (the saved ones,
 * or the panel's unsaved ones). Only human faces get the photographic mouth:
 * the server publishes the classic one for anything else, and the preview
 * must show what ships.
 */
export function draftMouthConfig(
  avatar: DraftMouthSource | undefined,
  renderer: MouthRenderer | undefined = avatar?.mouth?.renderer,
  profile: AvatarMouthConfig["profile"] = avatar?.mouth?.profile
): AvatarMouthConfig | null {
  if (!avatar || renderer !== "continuous" || (avatar.face_type ?? "human") !== "human") return null;
  return {
    renderer,
    profile,
    oral: avatar.mouth_photo ?? null,
    motion_url: avatar.mouth?.motion_url ?? null,
  };
}

/**
 * Which mouth shapes the dashboard preview plays: the avatar's own (its
 * draft motion, what visitors get once published) or the standard ones
 * (the bundled Reference motion, retargeted, what every avatar played
 * before it had its own). The Mouth panel's compare switch, so the owner
 * can hear the same sentence both ways. Never saved or published.
 */
export type MotionChoice = "own" | "standard";

/** `config` with the motion the owner chose to hear: the standard shapes
 * are the config without its own motion, as the loader reads it. The same
 * config for "own", and whenever there is no motion of its own to swap. */
export function previewMotion(config: AvatarMouthConfig | null, choice: MotionChoice): AvatarMouthConfig | null {
  if (!config || choice === "own" || !config.motion_url) return config;
  return { ...config, motion_url: null };
}

/**
 * Changes whenever the saved mouth does (save, publish, discard), so an
 * unsaved preview is dropped; but not when a refetch only re-signs its URLs.
 */
export function savedMouthKey(avatar: DraftMouthSource | undefined): string {
  const mouth = avatar?.mouth ?? null;
  return JSON.stringify([
    mouth && { ...mouth, motion_url: urlIdentity(mouth.motion_url) },
    Boolean(avatar?.mouth_photo),
  ]);
}
