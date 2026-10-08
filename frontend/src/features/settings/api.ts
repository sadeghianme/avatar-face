import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Integration, Org, Schemas, Usage } from "@/lib/types";

/** This month's allowance and what was used of it (the avatars page shows it too). */
export function useUsage(orgId: string | undefined, options: { staleTime?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.usage(orgId),
    queryFn: () => api.get<Usage>(`/orgs/${orgId}/usage`),
    enabled: Boolean(orgId),
    ...options,
  });
}

export function useRenameOrg(orgId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.patch<Org>(`/orgs/${orgId}`, { name } satisfies Schemas["OrgUpdate"]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.orgs() }),
  });
}

/**
 * The organization's third-party AI switch. Off takes effect at once on the
 * server, so the open wizard (its creations) and the consent terms are
 * refetched with the org: they show or hide their AI steps without a reload.
 */
export function useSetThirdPartyAi(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<Org>(`/orgs/${orgId}`, { third_party_ai_enabled: enabled } satisfies Schemas["OrgUpdate"]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgs() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.consentTerms(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.creations(orgId) });
    },
  });
}

export function useIntegrations(orgId: string) {
  return useQuery({
    queryKey: queryKeys.integrations(orgId),
    queryFn: () => api.get<Integration[]>(`/orgs/${orgId}/integrations`),
  });
}

/** New provider credentials; the voice and image provider lists follow them. */
export function useSaveIntegrations(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string>) =>
      api.put<Integration[]>(`/orgs/${orgId}/integrations`, { values } satisfies Schemas["IntegrationsUpdate"]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.integrations(orgId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.ttsProviders() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.imageGen() });
    },
  });
}

/** What Test found (POST …/test answers a dict: typed here). */
export interface IntegrationTest {
  ok: boolean;
  voices?: number;
  error?: string;
}

export function useTestIntegration(orgId: string) {
  return useMutation({
    mutationFn: (provider: string) => api.post<IntegrationTest>(`/orgs/${orgId}/integrations/${provider}/test`),
  });
}
