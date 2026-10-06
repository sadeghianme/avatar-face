import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The account pages' requests that are not the session itself (sign-in,
 * sign-up and the session live in providers/auth: every page reads them).
 */

export interface InviteInfo {
  org_name: string;
  email: string;
  role: string;
}

/** What an invitation link is for; a dead link is an error, not retried. */
export function useInvite(token: string | undefined) {
  return useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: () => api.get<InviteInfo>(`/invitations/${token}`),
    retry: false,
  });
}

/** Join the organization: it is in the org list from now on. */
export function useAcceptInvite(token: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/invitations/${token}/accept`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.orgs() }),
  });
}

/** Ask for a reset link. The answer is the same whether the address exists or not. */
export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => api.post("/auth/forgot-password", { email }),
  });
}

/** A new password from a reset link; answers with a session to adopt. */
export function useResetPassword() {
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      api.post<{ access_token: string; refresh_token: string }>("/auth/reset-password", body),
  });
}
