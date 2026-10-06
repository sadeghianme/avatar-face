import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";

import { type Creation, type HeldUrl, isBusy, pollDelay, stabilizeUrls } from "@/features/avatars/creation";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/**
 * One creation, kept current while the server works on it.
 *
 * Heavy steps are jobs: the route answers 202 and the creation changes
 * later. While a job is queued or running (or the avatar is being built)
 * this polls, quickly at first and backing off (creation.pollDelay; a
 * finish no slower than every two seconds, so step 5's count moves), and
 * stops by itself once the job is done, failed or interrupted. A hidden
 * tab does not poll (TanStack's default), and catches up when shown.
 *
 * `apply` puts a creation a mutation answered with into the cache, after
 * cancelling any poll in flight: that poll was sent before the mutation
 * and would otherwise land after it, showing the old state for a beat.
 */
export function useCreation(orgId: string | undefined, id: string | undefined) {
  const queryClient = useQueryClient();
  const key = useMemo(() => queryKeys.creation(orgId, id), [orgId, id]);
  // The fetch count when the current job was first seen: the backoff
  // restarts for every job. refetchInterval runs on every render, not once
  // per fetch, so it must derive the attempt, never count it.
  const watching = useRef<{ job: string; since: number } | null>(null);
  const held = useRef(new Map<string, HeldUrl>());

  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<Creation>(`/orgs/${orgId}/creations/${id}`),
    enabled: Boolean(orgId && id),
    // A creation that is gone stays gone; anything else is worth a retry.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!isBusy(data)) {
        watching.current = null;
        return false;
      }
      const job = data!.job?.id ?? data!.status;
      if (watching.current?.job !== job) {
        watching.current = { job, since: q.state.dataUpdateCount };
      }
      return pollDelay(q.state.dataUpdateCount - watching.current.since, data!.status === "finishing");
    },
  });

  const creation = useMemo(
    () => (query.data ? stabilizeUrls(query.data, held.current, Date.now()) : undefined),
    [query.data]
  );

  const apply = useCallback(
    async (next: Creation) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, next);
    },
    [queryClient, key]
  );

  return {
    creation,
    error: query.error,
    isLoading: query.isLoading,
    refetch: query.refetch,
    apply,
  };
}

export interface ActionError {
  code: string;
  detail: string;
  retryAfter: number | null;
  body: Record<string, unknown>;
}

function toActionError(err: unknown): ActionError {
  if (err instanceof ApiError) {
    return { code: err.code, detail: err.detail, retryAfter: err.retryAfter, body: err.body };
  }
  return {
    code: "network_error",
    detail: err instanceof Error ? err.message : String(err),
    retryAfter: null,
    body: {},
  };
}

// The server refused because what we showed is out of date: reload it, so
// the owner sees the real state under the explanation. An organization that
// switched AI off is one: the creation's `ai.enabled` says so once reloaded,
// and the AI steps give way to a sentence saying why.
const STALE = new Set([
  "creation_changed",
  "creation_not_draft",
  "creation_not_ready",
  "anchors_stale",
  "third_party_ai_disabled",
]);

/**
 * Run the wizard's requests one at a time: which one is busy, the last
 * error (with its code, so a step can react to it), and the creation any
 * of them answered with applied to the cache.
 */
export function useCreationActions(apply: (creation: Creation) => Promise<void>, refetch: () => unknown) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);

  const run = useCallback(
    async <T>(label: string, request: () => Promise<T>, toCreation?: (result: T) => Creation) => {
      setBusy(label);
      setError(null);
      try {
        const result = await request();
        const next = toCreation ? toCreation(result) : (result as unknown as Creation | undefined);
        if (next && typeof next === "object" && "steps" in next) await apply(next);
        return { ok: true as const, result };
      } catch (err) {
        const failure = toActionError(err);
        setError(failure);
        if (STALE.has(failure.code)) void refetch();
        return { ok: false as const, error: failure };
      } finally {
        setBusy(null);
      }
    },
    [apply, refetch]
  );

  return { busy, error, setError, run };
}

/** A step's handle on the wizard's request runner. */
export type Run = ReturnType<typeof useCreationActions>["run"];
