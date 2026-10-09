import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/Button";
import { api, getAccessToken } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { aUser } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer } from "@/test/server";

const session = (token: string) => ({ access_token: token, token_type: "bearer", expires_in: 900 });

/** Who the auth provider says is signed in, and its two actions. */
function Probe() {
  const { user, loading, logout } = useAuth();
  const [failures, setFailures] = useState(0);
  return (
    <div>
      <p>{loading ? "loading" : user ? `signed in as ${user.username}` : "signed out"}</p>
      <p>failures: {failures}</p>
      <Button onClick={() => void logout()}>Log out</Button>
      <Button onClick={() => void api.get("/things").catch(() => setFailures((n) => n + 1))}>Load</Button>
    </div>
  );
}

/** Every value in both storages, joined: where a script could read one. */
function storedValues(): string {
  return [localStorage, sessionStorage]
    .flatMap((storage) => Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i) ?? "")))
    .join(" ");
}

describe("AuthProvider", () => {
  it("restores the session from the refresh cookie on load, and keeps its token in memory only", async () => {
    // What the API sets beside the httpOnly refresh cookie (which no script,
    // this test included, can see).
    document.cookie = "lf_session=1; path=/";
    const server = createServer()
      .on("POST", "/auth/refresh", () => session("restored-access-token"))
      .on("GET", "/auth/me", () => aUser({ username: "ana" }));
    renderScreen(<Probe />, { signedIn: false, server });

    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();
    expect(server.requests("POST", "/auth/refresh")).toHaveLength(1);
    expect(server.requests("GET", "/auth/me")[0].headers.get("Authorization")).toBe("Bearer restored-access-token");
    expect(getAccessToken()).toBe("restored-access-token");
    expect(storedValues()).not.toContain("restored-access-token");
  });

  it("without the cookie, makes no request: a visitor who never signed in", async () => {
    const server = createServer();
    renderScreen(<Probe />, { signedIn: false, server });
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
  });

  it("removes the tokens an older release kept in localStorage", async () => {
    localStorage.setItem("liveface.tokens", JSON.stringify({ access_token: "old-a", refresh_token: "old-r" }));
    renderScreen(<Probe />, { signedIn: false });
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    expect(localStorage.getItem("liveface.tokens")).toBeNull();
    expect(storedValues()).not.toContain("old-r");
  });

  it("a session the server ended is nobody signed in", async () => {
    document.cookie = "lf_session=1; path=/";
    const server = createServer().on("POST", "/auth/refresh", () => apiError(401, "session_revoked"));
    renderScreen(<Probe />, { signedIn: false, server });
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    expect(server.requests("GET", "/auth/me")).toHaveLength(0);
    expect(getAccessToken()).toBeNull();
  });

  it("logout asks the API to end the session, and forgets the user, the token and the cache", async () => {
    const server = createServer().on("POST", "/auth/logout", () => undefined);
    const { user, queryClient } = renderScreen(<Probe />, { server });
    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();
    queryClient.setQueryData(["something", "private"], { secret: true });

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    const [request] = server.requests("POST", "/auth/logout");
    expect(request.headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(getAccessToken()).toBeNull();
    expect(queryClient.getQueryData(["something", "private"])).toBeUndefined();
  });

  it("a session ended elsewhere signs this tab out at its next request", async () => {
    const server = createServer()
      .on("GET", "/things", () => apiError(401, "session_revoked"))
      .on("POST", "/auth/refresh", () => apiError(401, "session_revoked"));
    const { user } = renderScreen(<Probe />, { server });
    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("failures: 1")).toBeInTheDocument());
    expect(server.requests("POST", "/auth/refresh")).toHaveLength(1);
    expect(getAccessToken()).toBeNull();
  });

  it("an expired access token is refreshed once and the request goes through", async () => {
    let refreshed = 0;
    const server = createServer()
      .on("GET", "/things", (request) =>
        request.headers.get("Authorization") === "Bearer second" ? { ok: true } : apiError(401, "invalid_token")
      )
      .on("POST", "/auth/refresh", () => {
        refreshed++;
        return session("second");
      });
    const { user } = renderScreen(<Probe />, { server });
    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load" }));
    await user.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() => expect(server.requests("GET", "/things")).toHaveLength(3));
    expect(refreshed).toBe(1);
    expect(screen.getByText("failures: 0")).toBeInTheDocument();
    expect(screen.getByText("signed in as ana")).toBeInTheDocument();
  });
});
