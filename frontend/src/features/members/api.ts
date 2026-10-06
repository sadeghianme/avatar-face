import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Invitation, Member, Role } from "@/lib/types";

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: () => api.get<Member[]>(`/orgs/${orgId}/members`),
    enabled: Boolean(orgId),
  });
}

/** Pending and past invitations (admins only: `enabled`). */
export function useInvitations(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invitations(orgId),
    queryFn: () => api.get<Invitation[]>(`/orgs/${orgId}/invitations`),
    enabled: Boolean(orgId) && enabled,
  });
}

/** Every change here moves a person between the two lists: both refetched. */
function useTeamMutation<T>(orgId: string | undefined, request: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.members(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.invitations(orgId) }),
      ]),
  });
}

export const useInvite = (orgId: string | undefined) =>
  useTeamMutation(orgId, (body: { email: string; role: Role }) => api.post(`/orgs/${orgId}/invitations`, body));

export const useChangeRole = (orgId: string | undefined) =>
  useTeamMutation(orgId, ({ membershipId, role }: { membershipId: string; role: Role }) =>
    api.patch(`/orgs/${orgId}/members/${membershipId}`, { role })
  );

export const useRemoveMember = (orgId: string | undefined) =>
  useTeamMutation(orgId, (membershipId: string) => api.delete(`/orgs/${orgId}/members/${membershipId}`));

export const useRevokeInvitation = (orgId: string | undefined) =>
  useTeamMutation(orgId, (invitationId: string) => api.delete(`/orgs/${orgId}/invitations/${invitationId}`));
