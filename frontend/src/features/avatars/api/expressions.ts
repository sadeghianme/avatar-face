import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAvatarCache } from "@/features/avatars/api/avatars";
import { type Delivery, type ExpressionsView, pollEvery } from "@/features/avatars/expressions";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Schemas } from "@/lib/types";

const expressionsPath = (orgId: string, avatarId: string) => `/orgs/${orgId}/avatars/${avatarId}/expressions`;

/**
 * The avatar's AI expression pictures: the choice, the kit and the job.
 * Asked afresh on every visit (a job or a batch may have ended since), and
 * again every EXPR_POLL_MS while a job runs, every minute while a batch is
 * on its way.
 */
export function useExpressions(orgId: string, avatarId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.expressions(orgId, avatarId),
    queryFn: () => api.get<ExpressionsView>(expressionsPath(orgId, avatarId)),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => pollEvery(query.state.data),
  });
}

/** Each write answers the whole view, taken as is; the avatar is fetched
 * again (the Publish bar and the disclosure follow what changed). */
function useExpressionsWrite<TInput>(
  orgId: string,
  avatarId: string,
  request: (input: TInput) => Promise<ExpressionsView>
) {
  const queryClient = useQueryClient();
  const cache = useAvatarCache(orgId, avatarId);
  return useMutation({
    mutationFn: request,
    onSuccess: async (view) => {
      queryClient.setQueryData(queryKeys.expressions(orgId, avatarId), view);
      await cache.refresh({ list: false });
    },
  });
}

/** The owner's choice: AI pictures or not (on, with the member's consent),
 * and how a publish makes them. */
export const useChooseExpressions = (orgId: string, avatarId: string) =>
  useExpressionsWrite(orgId, avatarId, (choice: { ai: boolean; consentId?: string; delivery?: Delivery }) =>
    api.put<ExpressionsView>(expressionsPath(orgId, avatarId), {
      ai: choice.ai,
      consent_id: choice.consentId ?? null,
      delivery: choice.delivery ?? null,
    } satisfies Schemas["ExpressionsChoice"])
  );

/** Make the five pictures now (a job, followed by useExpressions). */
export const useMakeExpressions = (orgId: string, avatarId: string) =>
  useExpressionsWrite(orgId, avatarId, (consentId: string) =>
    api.post<ExpressionsView>(`${expressionsPath(orgId, avatarId)}/make`, {
      consent_id: consentId,
    } satisfies Schemas["ExpressionsMake"])
  );

/** Remove the pictures from the draft (the choice goes off). */
export const useRemoveExpressions = (orgId: string, avatarId: string) =>
  useExpressionsWrite(orgId, avatarId, () => api.delete<ExpressionsView>(expressionsPath(orgId, avatarId)));
