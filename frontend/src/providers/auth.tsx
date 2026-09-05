import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { api, getTokens, setTokens } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (usernameOrEmail: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  /** Adopt tokens obtained outside the login form (password reset). */
  adoptSession: (tokens: { access_token: string; refresh_token: string }) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getTokens()) {
      setLoading(false);
      return;
    }
    api
      .get<User>("/auth/me")
      .then(setUser)
      .catch(() => setTokens(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (usernameOrEmail: string, password: string) => {
    const tokens = await api.post<{ access_token: string; refresh_token: string }>(
      "/auth/login",
      { username_or_email: usernameOrEmail, password }
    );
    setTokens(tokens);
    setUser(await api.get<User>("/auth/me"));
  }, []);

  /** Adopt tokens obtained outside the normal login form.
   *
   * Password reset signs the user in as part of finishing, and writing the
   * tokens to storage is not enough on its own: the context still believes
   * nobody is signed in, so the next Protected route bounces to /login — the
   * exact detour the flow exists to avoid.
   */
  const adoptSession = useCallback(
    async (tokens: { access_token: string; refresh_token: string }) => {
      setTokens(tokens);
      setUser(await api.get<User>("/auth/me"));
    },
    []
  );

  const register = useCallback(
    async (email: string, username: string, password: string, displayName?: string) => {
      await api.post("/auth/register", {
        email,
        username,
        password,
        display_name: displayName ?? "",
      });
      await login(username, password);
    },
    [login]
  );

  const logout = useCallback(() => {
    setTokens(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, adoptSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
