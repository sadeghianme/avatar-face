import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { needsPersonalOrg, settingUpWorkspace } from "@/lib/orgSetup";
import { queryKeys } from "@/lib/queryKeys";
import type { Org } from "@/lib/types";
import { useAuth } from "@/providers/auth";

interface OrgState {
  orgs: Org[];
  current: Org | null;
  setCurrent: (org: Org) => void;
  createOrg: (name: string) => Promise<Org>;
  /** True until the organizations are known, and while a new account's
   * personal one is being made (nothing to show before it exists). */
  loading: boolean;
  /** Making the personal organization failed; `retrySetup` tries again. */
  setupFailed: boolean;
  retrySetup: () => void;
}

const OrgContext = createContext<OrgState | null>(null);
const LAST_ORG_KEY = "liveface.lastOrg";

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState<string | null>(localStorage.getItem(LAST_ORG_KEY));

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: queryKeys.orgs(),
    queryFn: () => api.get<Org[]>("/orgs"),
    enabled: Boolean(user),
  });

  // A new account gets its personal organization, once. The request is
  // idempotent on the server (one personal organization per user), and the
  // guard here keeps this tab from sending it twice anyway: the effect runs
  // again whenever `user` or the list changes while the request is still in
  // flight. The list reads as loading until it lands, so there is no blank
  // page and no "+ Create organization" to press meanwhile.
  const settingUp = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const state = {
      userId: user?.id ?? null,
      loaded: !isLoading,
      orgCount: orgs.length,
      requestedFor: settingUp.current,
    };
    if (!user || !needsPersonalOrg(state)) return;
    settingUp.current = user.id;
    setPending(true);
    setSetupFailed(false);
    api
      .post<Org>("/orgs", { name: `${user.display_name || user.username}'s space`, personal: true })
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.orgs() });
        // Made but not listed (a failed refetch): say so, rather than wait forever.
        if (!queryClient.getQueryData<Org[]>(["orgs"])?.length) throw new Error("not listed");
      })
      .catch(() => {
        settingUp.current = null;
        setSetupFailed(true);
      })
      .finally(() => setPending(false));
  }, [user, isLoading, orgs.length, attempt, queryClient]);

  const retrySetup = useCallback(() => {
    setSetupFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  const current = orgs.find((o) => o.id === currentId) ?? orgs[0] ?? null;

  const setCurrent = useCallback((org: Org) => {
    localStorage.setItem(LAST_ORG_KEY, org.id);
    setCurrentId(org.id);
  }, []);

  const createOrg = useCallback(
    async (name: string) => {
      const org = await api.post<Org>("/orgs", { name });
      await queryClient.invalidateQueries({ queryKey: queryKeys.orgs() });
      setCurrent(org);
      return org;
    },
    [queryClient, setCurrent]
  );

  return (
    <OrgContext.Provider
      value={{
        orgs,
        current,
        setCurrent,
        createOrg,
        loading:
          settingUpWorkspace({
            userId: user?.id ?? null,
            loaded: !isLoading,
            orgCount: orgs.length,
            failed: setupFailed,
          }) || pending,
        setupFailed,
        retrySetup,
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg outside OrgProvider");
  return ctx;
}
