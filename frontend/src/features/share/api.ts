import type { Cue } from "@liveface/embed";

import type { Schemas } from "@/lib/types";

/**
 * The share page's requests: the PUBLIC endpoints, with no account and no
 * token (so not the dashboard's client, which signs every call). One-shot
 * steps of the page's engine boot and of a press of Play, not cached server
 * state: plain functions, not query hooks (docs/frontend-ui.md, "Data").
 */

/**
 * The PUBLISHED avatar behind a share link (the backend's
 * schemas.published.PublishedAvatarOut, the same answer a customer's widget
 * gets less its id): its face type, scene, voice, mouth (null: the classic
 * one) and, on snapshots published since disclosures were recorded, its
 * disclosure. Generated from the API's schema, never written by hand.
 */
export type PublicAvatar = Schemas["PublishedAvatarOut"];

/** The published avatar behind a share link; throws when it is gone. */
export async function fetchPublicAvatar(token: string | undefined): Promise<PublicAvatar> {
  const response = await fetch(`/api/public/v1/avatars/${token}`);
  if (!response.ok) throw new Error("unavailable");
  return (await response.json()) as PublicAvatar;
}

/** A visitor's line in a server voice: the audio and its mouth cues. */
export type SpokenAudio = Schemas["PublicSpeech"];

/** A voice as the speak endpoint takes it. */
export interface PublicVoice {
  provider: string;
  voice: string;
  locale: string;
}

/**
 * The words in a server voice, or why not: the API's error code (null when
 * it sent none) — `cloned_line_missing` for a line the avatar's cloned voice
 * was never given, anything else when the server cannot speak at all (no
 * voice on this instance, or throttled), where the caller then speaks with
 * the browser's.
 */
export async function speakPublic(
  token: string | undefined,
  body: PublicVoice & { text: string }
): Promise<{ spoken: SpokenAudio } | { refused: string | null }> {
  const response = await fetch(`/api/public/v1/avatars/${token}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { spoken: (await response.json()) as SpokenAudio };
  const refusal = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return { refused: typeof refusal?.code === "string" ? refusal.code : null };
}

/**
 * The server's own voice for `locale` (GET /tts/languages, public: each
 * language resolved to its best server voice), else the default English
 * one: what a cloned voice's missing line is said in instead.
 */
export async function serverVoiceFor(locale: string): Promise<PublicVoice> {
  const fallback = { provider: "kokoro", voice: "af_heart", locale: "en-US" };
  const response = await fetch("/api/tts/languages").catch(() => null);
  if (!response?.ok) return fallback;
  const languages = (await response.json().catch(() => [])) as PublicVoice[];
  const language = Array.isArray(languages) ? languages.find((l) => l.locale === locale) : undefined;
  return language ? { provider: language.provider, voice: language.voice, locale: language.locale } : fallback;
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
  const body = (await response.json()) as Schemas["CueResponse"];
  return { cues: body.cues, durationMs: body.duration_ms, wordMarks: body.word_marks };
}
