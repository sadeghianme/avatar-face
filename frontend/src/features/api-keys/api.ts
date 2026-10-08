import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { ApiKeyInfo, Schemas } from "@/lib/types";

/** A new key: its record, and the plaintext this one response carries. */
/** A new key, with its secret: shown once. */
export type CreatedKey = Schemas["ApiKeyCreated"];

/** The organization's widget keys (owners and admins only: `enabled`). */
export function useApiKeys(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.apiKeys(orgId),
    queryFn: () => api.get<ApiKeyInfo[]>(`/orgs/${orgId}/api-keys`),
    enabled: Boolean(orgId) && enabled,
  });
}

export function useCreateApiKey(orgId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ApiKeyCreate"]) => api.post<CreatedKey>(`/orgs/${orgId}/api-keys`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(orgId) }),
  });
}

export function useRevokeApiKey(orgId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => api.delete(`/orgs/${orgId}/api-keys/${keyId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(orgId) }),
  });
}
