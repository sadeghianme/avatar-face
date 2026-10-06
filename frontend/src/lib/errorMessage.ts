/**
 * What a failed request says to a person: the server's own sentence
 * (ApiError.detail) when it gave one, else `fallback` (the translated
 * "Something went wrong"). Framework-free: it reads the error's shape
 * rather than importing the client, so `npm test` checks it.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "detail" in err && "status" in err) {
    const detail = (err as { detail: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
  }
  return fallback;
}
