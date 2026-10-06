import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * A fresh Simulator credential (15 minutes), minted per run: cheap, and
 * never cached (a mutation, not a query).
 */
export function useSimulatorToken(orgId: string | undefined) {
  return useMutation({
    mutationFn: async () => (await api.post<{ token: string }>(`/orgs/${orgId}/api-keys/simulator-token`)).token,
  });
}
