import { useEffect, useRef, useState } from "react";

import {
  useAvatarCache,
  useChooseExpressions,
  useExpressions,
  useMakeExpressions,
  useRemoveExpressions,
} from "@/features/avatars/api";
import { type Delivery, exprStage, isExprActive, refusalKey, shotsView } from "@/features/avatars/expressions";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/**
 * The Expressions panel's state and requests (ExpressionsPanel draws them):
 * the owner's choice (on asks the member's third-party AI consent first,
 * useConsent.withAi), how a publish makes the pictures, Make now (a job,
 * followed until it ends), Remove, and the words for each.
 *
 * Only for a person's photo avatar: the server makes no pictures for an
 * animal or a cartoon (their expressions are animated), and the panel is
 * not shown for them.
 */
export function useExpressionsPanel(avatar: Avatar, orgId: string) {
  const { t } = useT();
  const consent = useConsent(orgId);
  const view = useExpressions(orgId, avatar.id);
  const choose = useChooseExpressions(orgId, avatar.id);
  const make = useMakeExpressions(orgId, avatar.id);
  const remove = useRemoveExpressions(orgId, avatar.id);
  const cache = useAvatarCache(orgId, avatar.id);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const data = view.data;
  const job = data?.job ?? null;
  const running = isExprActive(job) ? job : null;

  // A job that was running and is not any more: the avatar changed (the
  // Publish bar, the disclosure); a failure is said.
  const wasRunning = useRef<string | null>(null);
  const refreshAvatar = useRef(cache.refresh);
  refreshAvatar.current = cache.refresh;
  useEffect(() => {
    if (running) {
      wasRunning.current = running.id;
      return;
    }
    if (wasRunning.current && job && job.id === wasRunning.current) {
      wasRunning.current = null;
      void refreshAvatar.current({ list: false });
      if (job.state === "failed") setError(job.error?.detail || null);
    }
  }, [running, job]);

  /** A refused request in words: the panel's own for what it knows. */
  const refusal = (err: unknown): string => {
    if (!(err instanceof ApiError)) return t("error");
    const key = refusalKey(err.code);
    return key ? t(key) : err.detail || t("error");
  };

  const run = async (send: (consentId: string) => Promise<unknown>) => {
    setError(null);
    setAsking(true);
    try {
      await consent.withAi(t("exprPurpose"), send);
    } catch (err) {
      setError(refusal(err));
    } finally {
      setAsking(false);
    }
  };

  const setAi = async (on: boolean) => {
    if (on) {
      await run((consentId) => choose.mutateAsync({ ai: true, consentId }));
      return;
    }
    setError(null);
    try {
      await choose.mutateAsync({ ai: false });
    } catch (err) {
      setError(refusal(err));
    }
  };

  const setDelivery = async (delivery: Delivery) => {
    if (!data?.ai) return;
    setError(null);
    try {
      await run((consentId) => choose.mutateAsync({ ai: true, consentId, delivery }));
    } catch (err) {
      setError(refusal(err));
    }
  };

  const stage = exprStage(running);
  const count = running?.progress?.count ?? null;
  return {
    view: data,
    loading: view.isPending,
    loadError: view.isError ? t("error") : null,
    aiEnabled: consent.aiEnabled,
    ai: Boolean(data?.ai),
    delivery: (data?.delivery ?? "now") as Delivery,
    pending: Boolean(data?.pending),
    made: data?.kit?.made ?? 0,
    shots: shotsView(data),
    running,
    count,
    progressText: stage ? t(`exprStage_${stage}`) : t("exprStage_making"),
    busy: asking || choose.isPending || make.isPending || remove.isPending,
    error,
    setAi,
    setDelivery,
    make: () => run((consentId) => make.mutateAsync(consentId)),
    remove: async () => {
      setError(null);
      try {
        await remove.mutateAsync(undefined);
      } catch (err) {
        setError(refusal(err));
      }
    },
    removing: remove.isPending,
    consentDialog: consent.dialog,
  };
}

export type ExpressionsPanelState = ReturnType<typeof useExpressionsPanel>;
