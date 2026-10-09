/**
 * A screen as the app mounts it (main.tsx's providers, a router at a
 * route), against the mocked API (server.ts). Signed in by default: an
 * access token in memory (lib/api), as after a sign-in, and the session's
 * two requests (/auth/me, /orgs) answered with `user` and `orgs`.
 *
 *   const { server, user } = renderScreen(<AvatarsPage />, { route: "/app" });
 *
 * `path` is the route's pattern (for useParams); `routes` adds the pages a
 * screen navigates to (each a marker is enough). The current location is
 * in `location()`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { setAccessToken } from "@/lib/api";
import type { Org, User } from "@/lib/types";
import { AuthProvider } from "@/providers/auth";
import { OrgProvider } from "@/providers/org";
import { ThemeProvider } from "@/providers/theme";
import { anOrg, aUser } from "@/test/fixtures";
import { createServer, type MockServer } from "@/test/server";

/** The query client a test gets: no retries (a refusal shows at once), nothing collected mid-test. */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, networkMode: "always" },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

let lastLocation = "";
function LocationProbe() {
  const location = useLocation();
  lastLocation = `${location.pathname}${location.search}`;
  return null;
}

export interface ScreenOptions {
  /** The URL the router starts at, or a location with its state. */
  route?: string | { pathname: string; search?: string; state?: unknown };
  /** The route pattern the screen is mounted on. */
  path?: string;
  /** Other routes: what a navigation from the screen lands on. */
  routes?: Record<string, ReactNode>;
  /** false: nobody signed in (no token, no session requests). */
  signedIn?: boolean;
  user?: User;
  orgs?: Org[];
  /** Routes to add before the screen mounts. */
  server?: MockServer;
}

export interface Screen extends RenderResult {
  server: MockServer;
  user: UserEvent;
  queryClient: QueryClient;
  /** pathname + search where the router is now. */
  location: () => string;
}

export function renderScreen(ui: ReactElement, options: ScreenOptions = {}): Screen {
  const { route = "/", path = "*", routes = {}, signedIn = true, user = aUser(), orgs = [anOrg()] } = options;
  const server = options.server ?? createServer();
  if (signedIn) {
    setAccessToken("test-access-token");
    // Defaults: a test's own routes for them win.
    server.fallback("GET", "/auth/me", () => user).fallback("GET", "/orgs", () => orgs);
  }
  server.install();
  const queryClient = testQueryClient();
  const events = userEvent.setup();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <OrgProvider>
            <MemoryRouter initialEntries={[route]}>
              <LocationProbe />
              <Routes>
                <Route path={path} element={ui} />
                {Object.entries(routes).map(([to, element]) => (
                  <Route key={to} path={to} element={element} />
                ))}
              </Routes>
            </MemoryRouter>
          </OrgProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  return { ...result, server, user: events, queryClient, location: () => lastLocation };
}
