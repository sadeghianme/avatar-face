import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { api } from "./api";
import { useAuth } from "./auth";
import type { Org } from "./types";

interface OrgState {
  orgs: Org[];
  current: Org | null;
  setCurrent: (org: Org) => void;
  createOrg: (name: string) => Promise<Org>;
  loading: boolean;
}

const OrgContext = createContext<OrgState | null>(null);
const LAST_ORG_KEY = "liveface.lastOrg";

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState<string | null>(
    localStorage.getItem(LAST_ORG_KEY)
  );

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ["orgs"],
    queryFn: () => api.get<Org[]>("/orgs"),
    enabled: Boolean(user),
  });

  // Auto-create a personal org on first login so the app is usable instantly.
  useEffect(() => {
    if (user && !isLoading && orgs.length === 0) {
      void api
        .post<Org>("/orgs", { name: `${user.display_name || user.username}'s space` })
        .then(() => queryClient.invalidateQueries({ queryKey: ["orgs"] }));
    }
  }, [user, isLoading, orgs.length, queryClient]);

  const current = orgs.find((o) => o.id === currentId) ?? orgs[0] ?? null;

  const setCurrent = useCallback((org: Org) => {
    localStorage.setItem(LAST_ORG_KEY, org.id);
    setCurrentId(org.id);
  }, []);

  const createOrg = useCallback(
    async (name: string) => {
      const org = await api.post<Org>("/orgs", { name });
      await queryClient.invalidateQueries({ queryKey: ["orgs"] });
      setCurrent(org);
      return org;
    },
    [queryClient, setCurrent]
  );

  return (
    <OrgContext.Provider
      value={{ orgs, current, setCurrent, createOrg, loading: isLoading }}
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
