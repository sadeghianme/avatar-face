import { useQueryClient } from "@tanstack/react-query";
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";

import {
  api,
  forgetLegacyTokens,
  getAccessToken,
  hasSessionHint,
  onSignedOut,
  refreshSession,
  type SessionToken,
  setAccessToken,
  signOut,
} from "@/lib/api";
import type { Schemas, User } from "@/lib/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (usernameOrEmail: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string, displayName?: string) => Promise<void>;
  /** Sign this browser out (the API ends its session). */
  logout: () => Promise<void>;
  /** Sign out every session of the account, this one included. Throws,
   *  signed in still, if the API refuses. */
  logoutEverywhere: () => Promise<void>;
  /** Adopt a session started outside the login form (password reset). */
  adoptSession: (session: SessionToken) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Who is signed in. On load the session is restored from the refresh cookie
 * (lib/api: the access token is kept in memory only), when the API's
 * lf_session cookie says there is one: a visitor who never signed in makes
 * no request. A session the server ends (signed out elsewhere, a new
 * password, a stolen token reused) signs this tab out at its next request.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /** What the signed-in user saw goes with them: the next one to sign in
   *  on this browser starts from an empty cache. */
  const signedOut = useCallback(() => {
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  useEffect(() => onSignedOut(signedOut), [signedOut]);

  useEffect(() => {
    forgetLegacyTokens();
    let live = true;
    const restore = async (): Promise<User | null> => {
      if (getAccessToken() === null && !(hasSessionHint() && (await refreshSession()))) return null;
      return api.get<User>("/auth/me");
    };
    void restore()
      .catch(() => null)
      .then((restored) => {
        if (live) setUser(restored);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const adoptSession = useCallback(async (session: SessionToken) => {
    setAccessToken(session.access_token);
    setUser(await api.get<User>("/auth/me"));
  }, []);

  const login = useCallback(
    async (usernameOrEmail: string, password: string) => {
      const session = await api.post<Schemas["AccessToken"]>("/auth/login", {
        username_or_email: usernameOrEmail,
        password,
      } satisfies Schemas["LoginRequest"]);
      await adoptSession(session);
    },
    [adoptSession]
  );

  const register = useCallback(
    async (email: string, username: string, password: string, displayName?: string) => {
      await api.post<User>("/auth/register", {
        email,
        username,
        password,
        display_name: displayName ?? "",
      } satisfies Schemas["RegisterRequest"]);
      await login(username, password);
    },
    [login]
  );

  const logout = useCallback(async () => {
    await signOut();
    signedOut();
  }, [signedOut]);

  const logoutEverywhere = useCallback(async () => {
    await signOut({ everywhere: true });
    signedOut();
  }, [signedOut]);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, logoutEverywhere, adoptSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
