import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Avatar } from "@/lib/types";

/** Still being built: the rig pipeline is running. */
const building = (status: string | undefined) => status === "pending" || status === "processing";

/**
 * The organization's avatars. `poll`: every 2s while one of them is being
 * built (the library, where a card turns ready on its own).
 */
export function useAvatars(orgId: string | undefined, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.avatars(orgId),
    queryFn: () => api.get<Avatar[]>(`/orgs/${orgId}/avatars`),
    enabled: Boolean(orgId),
    refetchInterval: poll ? (query) => (query.state.data?.some((a) => building(a.status)) ? 2000 : false) : undefined,
  });
}

/**
 * One avatar, with its signed asset URLs (the list has none). `poll`:
 * every 1.5s while it is being built (its own page).
 */
export function useAvatar(
  orgId: string | undefined,
  avatarId: string | undefined,
  { poll = false, enabled = true, staleTime }: { poll?: boolean; enabled?: boolean; staleTime?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.avatar(orgId, avatarId),
    queryFn: () => api.get<Avatar>(`/orgs/${orgId}/avatars/${avatarId}`),
    enabled: Boolean(orgId && avatarId) && enabled,
    staleTime,
    refetchInterval: poll ? (query) => (building(query.state.data?.status) ? 1500 : false) : undefined,
  });
}
