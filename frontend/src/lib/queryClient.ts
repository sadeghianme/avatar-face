/**
 * The app's React Query defaults (main.tsx). Framework-free apart from the
 * client itself, so the retry rule is tested with `node --test`.
 */
import { QueryClient } from "@tanstack/react-query";

/** What `retry` needs to know of an error: the HTTP status, when there is one. */
interface WithStatus {
  status?: unknown;
}

/**
 * Whether a failed query is asked once more. A network error or a 5xx may
 * pass on a second try; a 4xx will not (a 404 stays gone, a 403 stays
 * refused), except 408 and 429, which say "later". One retry at most.
 */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (failures >= 1) return false;
  const status = typeof error === "object" && error !== null ? (error as WithStatus).status : undefined;
  if (typeof status !== "number" || status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 10_000,
        // Don't pause queries on flaky onLine signals (embedded webviews and
        // headless browsers misreport connectivity); let fetch itself fail.
        networkMode: "always",
      },
    },
  });
}
