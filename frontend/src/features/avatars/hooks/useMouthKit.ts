import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DraftStore } from "@/features/avatars/creation";
import {
  heldKitJob,
  isKitActive,
  KIT_POLL_MS,
  type KitJobAnswer,
  type KitOutcome,
  kitOutcome,
  type KitStage,
  kitStage,
  rememberKitJob,
} from "@/features/avatars/mouth-kit";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** How the job this tab followed ended, and what it was last seen doing
 * (a failure while making the teeth alone is worded as the teeth's). */
export type KitEnding = Exclude<KitOutcome, { kind: "running" }> & { lastStage: KitStage | null };

/**
 * The Mouth panel's job: the person's mouth shapes and teeth made from the
 * avatar's picture (POST …/mouth-kit, a draft edit), followed until it ends
 * (GET the same path, every KIT_POLL_MS while it runs).
 *
 * The job this tab started is held, and kept for the tab (mouth-kit
 * .rememberKitJob), so a reload or a visit elsewhere mid-job picks it up
 * again, and one that ended meanwhile still says how. A job found running
 * is followed too: another tab's, or the one a 409 mouth_kit_in_progress
 * says is there. When a followed job ends, `onEnded` is told once (done:
 * the caller refetches the avatar; failed; interrupted, the server no
 * longer knowing it) and it is let go.
 *
 * `start(consentId)` resolves once the job is started or found running;
 * any other refusal is thrown for the caller to word.
 */
export function useMouthKit(orgId: string, avatarId: string, enabled: boolean, onEnded: (ending: KitEnding) => void) {
  const queryClient = useQueryClient();
  const key = useMemo(() => queryKeys.mouthKit(orgId, avatarId), [orgId, avatarId]);
  const base = `/orgs/${orgId}/avatars/${avatarId}/mouth-kit`;
  const [held, setHeld] = useState<string | null>(() => heldKitJob(tabStore(), avatarId));
  const lastStage = useRef<KitStage | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  // The held job whose ending was told: once, even when an effect runs
  // twice (React's development double mount).
  const told = useRef<string | null>(null);

  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<KitJobAnswer>(base),
    enabled,
    // Asked afresh on every visit: a job may have started or ended since.
    staleTime: 0,
    refetchInterval: (q) => (isKitActive(q.state.data?.job) ? KIT_POLL_MS : false),
  });

  const hold = useCallback(
    (id: string | null) => {
      setHeld(id);
      rememberKitJob(tabStore(), avatarId, id);
    },
    [avatarId]
  );

  // Nothing is concluded before the server has answered once: a held id
  // with no answer yet is not an interrupted job. One object per answer
  // and held id, so the effect below runs when either changes.
  const job = query.data?.job ?? null;
  const outcome = useMemo(() => (query.data ? kitOutcome(query.data.job, held) : null), [query.data, held]);
  const stage = kitStage(job);
  if (stage) lastStage.current = stage;

  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === "running") {
      // Followed from here on, whoever started it.
      if (outcome.job.id !== held) hold(outcome.job.id);
      return;
    }
    if (told.current !== held) {
      told.current = held;
      ended.current({ ...outcome, lastStage: lastStage.current });
    }
    lastStage.current = null;
    hold(null);
  }, [outcome, held, hold]);

  const start = useCallback(
    async (consentId: string): Promise<void> => {
      lastStage.current = null;
      try {
        const answer = await api.post<KitJobAnswer>(base, { consent_id: consentId });
        if (answer.job) {
          hold(answer.job.id);
          queryClient.setQueryData(key, answer);
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "mouth_kit_in_progress")) throw err;
        // One runs already (another tab's, a second press): follow it.
        const answer = await queryClient.fetchQuery({
          queryKey: key,
          queryFn: () => api.get<KitJobAnswer>(base),
          staleTime: 0,
        });
        if (answer.job && isKitActive(answer.job)) hold(answer.job.id);
      }
    },
    [base, key, hold, queryClient]
  );

  return {
    /** The job running now (this tab's or one found), or null. */
    running: outcome?.kind === "running" ? outcome.job : null,
    stage,
    start,
  };
}
