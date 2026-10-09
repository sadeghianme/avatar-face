/**
 * Why a line could not be said, as the API says it: the `code` to branch on
 * (`cloned_line_missing`, `usage_limit_reached`, `speech_busy`…), the
 * `detail` (a sentence for a person, in English) and the HTTP `status` of
 * the refusal — inside a speech stream too, whose own status went out as
 * 200 before anything failed.
 *
 * Thrown by `streamSpeech` for an error frame or a refused request, and by
 * the widget's `Liveface.speak()` when the server refuses a line, so a page
 * can tell "this line was never rendered in the cloned voice" from "try
 * again later" without reading prose.
 */
export class SpeechError extends Error {
  readonly code: string;
  readonly detail: string;
  /** The refusal's HTTP status; null when the server did not say. */
  readonly status: number | null;

  constructor(code: string, detail: string, status: number | null = null) {
    // The message keeps the code and the status: a console line, or a log
    // that matches on them (the Simulator renews a refused key on "401").
    super(`${detail} (${status ? `${status} ` : ""}${code})`);
    this.name = "SpeechError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

const words = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A speech stream's `error` frame ({code, detail, status}) as a SpeechError. */
export function speechErrorOfFrame(frame: Record<string, unknown>): SpeechError {
  const status = Number.isInteger(frame.status) ? (frame.status as number) : null;
  return new SpeechError(
    words(frame.code) ?? "speech_stream_failed",
    words(frame.detail) ?? "Speech preparation was interrupted",
    status
  );
}

/** A refused speech request as a SpeechError: the API's {code, detail} when it sent them. */
export async function speechErrorOfResponse(response: Response): Promise<SpeechError> {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return new SpeechError(
    words(body?.code) ?? `http_${response.status}`,
    words(body?.detail) ?? `The speech request answered ${response.status}`,
    response.status
  );
}
