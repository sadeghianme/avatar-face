/**
 * A line that could not be said, in the member's words: the dashboard's own
 * sentence for the codes it knows (`speechErr.<code>`, each key checked by
 * tsc), the server's sentence for any other refusal, and the translated
 * "Something went wrong" only when nothing said why (the network, a broken
 * stream). It reads the error's shape — the `code` and `detail` that
 * ApiError (a refused request) and the embed's SpeechError (a refusal
 * inside a speech stream) both carry — rather than importing either, so
 * `npm test` checks it.
 */
import type { Translate } from "@/i18n/types";

/** The speech refusals the dashboard words itself (backend codes). */
export const SPEECH_ERRORS = [
  // A cloned voice says only the lines rendered in it (services/tts/cloned.py).
  "cloned_line_missing",
  "speech_busy",
  "speech_stream_failed",
  "usage_limit_reached",
  "nothing_to_speak",
  "provider_not_configured",
] as const;

export type SpeechErrorCode = (typeof SPEECH_ERRORS)[number];
const KNOWN: ReadonlySet<string> = new Set(SPEECH_ERRORS);

export interface SpeechFailure {
  /** The server's code, for the next step it calls for; null when none was given. */
  code: string | null;
  /** What to show. */
  text: string;
}

function said(err: unknown, key: "code" | "detail"): string | null {
  if (!err || typeof err !== "object" || !(key in err)) return null;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

export function speechFailure(t: Translate, err: unknown): SpeechFailure {
  const code = said(err, "code");
  if (code && KNOWN.has(code)) return { code, text: t(`speechErr.${code as SpeechErrorCode}`) };
  return { code, text: said(err, "detail") ?? t("error") };
}
