import type { Cue, Scene } from "@liveface/embed";
import type { AvatarMouthConfig, ClassicMouthConfig } from "@liveface/embed/mouth";

import type { FaceType } from "@/lib/types";

/**
 * The share page's requests: the PUBLIC endpoints, with no account and no
 * token (so not the dashboard's client, which signs every call). One-shot
 * steps of the page's engine boot and of a press of Play, not cached server
 * state: plain functions, not query hooks (docs/frontend-ui.md, "Data").
 */

export interface PublicAvatar {
  name: string;
  kind: string;
  framing: string;
  /** What the avatar is, as PUBLISHED: how the engine moves its head (a
   *  person's in depth, an animal's or a cartoon's as a layer). Absent from
   *  a server before it said so: the rig decides. */
  face_type?: FaceType;
  /** The PUBLISHED scene; null for a snapshot from before scenes existed,
   *  which renders by its framing. */
  scene?: Scene | null;
  rig_url: string;
  image_url: string;
  thumbnail_url: string;
  layer_urls?: Record<string, string> | null;
  voice?: { provider: string; voice: string; locale: string } | null;
  /** The PUBLISHED mouth; null means the classic one. */
  mouth?: AvatarMouthConfig | ClassicMouthConfig | null;
  /** Absent on snapshots published before disclosures were recorded. */
  disclosure?: {
    ai_edited: { mode: string; model: string | null } | null;
    line: "human" | "animal" | "cartoon";
  };
}

/** The published avatar behind a share link; throws when it is gone. */
export async function fetchPublicAvatar(token: string | undefined): Promise<PublicAvatar> {
  const response = await fetch(`/api/public/v1/avatars/${token}`);
  if (!response.ok) throw new Error("unavailable");
  return (await response.json()) as PublicAvatar;
}

export interface SpokenAudio {
  audio_b64: string;
  audio_mime: string;
  cues: Cue[];
}

/**
 * The words in a server voice, or null when the server cannot (no voice on
 * this instance, or throttled): the caller then speaks with the browser's.
 */
export async function speakPublic(
  token: string | undefined,
  body: { text: string; provider: string; voice: string; locale: string }
): Promise<SpokenAudio | null> {
  const response = await fetch(`/api/public/v1/avatars/${token}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok ? ((await response.json()) as SpokenAudio) : null;
}

/** Mouth cues for a phrase the browser speaks (the widget's public endpoint). */
export async function phraseCues(
  phrase: string
): Promise<{ cues: Cue[]; durationMs: number; wordMarks: { char: number; t: number }[] } | null> {
  const response = await fetch("/api/embed/v1/cues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: phrase, locale: "en-US" }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    cues: Cue[];
    duration_ms: number;
    word_marks: { char: number; t: number }[];
  };
  return { cues: body.cues, durationMs: body.duration_ms, wordMarks: body.word_marks };
}
