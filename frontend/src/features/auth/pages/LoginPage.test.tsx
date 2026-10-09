import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/features/auth";
import { translate } from "@/i18n";
import { getAccessToken } from "@/lib/api";
import { expectAccessible } from "@/test/axe";
import { aUser } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer } from "@/test/server";

// The live avatar beside the form is the engine on a canvas: not this test's.
vi.mock("@/components/brand/DemoAvatar", () => ({ DEMO_PORTRAIT: "", DemoAvatar: () => null }));

const t = translate;

const TOKEN = "eyJ.access-token-of-ana.sig";

function setup() {
  const server = createServer();
  const screenApi = renderScreen(<LoginPage />, {
    route: "/login",
    path: "/login",
    signedIn: false,
    server,
    routes: { "/app": <p>The library</p> },
  });
  const identifier = screen.getByRole("textbox", { name: t("usernameOrEmail") });
  const password = screen.getByLabelText(t("password"), { selector: "input" });
  return { ...screenApi, identifier, password };
}

describe("LoginPage", () => {
  it("is a form with a labelled username and password, the first one focused", () => {
    const { identifier, password } = setup();
    expect(screen.getByRole("heading", { name: t("welcomeBack") })).toBeInTheDocument();
    expect(identifier).toHaveFocus();
    expect(identifier).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: t("forgotPassword") })).toHaveAttribute("href", "/forgot-password");
  });

  it("an empty form says what is missing beside each field, and sends nothing", async () => {
    const { user, identifier, password, server } = setup();
    await user.click(screen.getByRole("button", { name: t("login") }));
    await waitFor(() => expect(identifier).toHaveAttribute("aria-invalid", "true"));
    expect(identifier).toHaveAccessibleDescription(t("identifierRequired"));
    expect(password).toHaveAttribute("aria-invalid", "true");
    expect(password).toHaveAccessibleDescription(t("passwordRequired"));
    // Each announced as it appears.
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      t("identifierRequired"),
      t("passwordRequired"),
    ]);
    expect(server.requests("POST", "/auth/login")).toHaveLength(0);
  });

  it("signs in, keeps the session in memory only and goes to the library", async () => {
    const { user, identifier, password, server, location } = setup();
    server
      .on("POST", "/auth/login", () => ({ access_token: TOKEN, token_type: "bearer", expires_in: 900 }))
      .on("GET", "/auth/me", () => aUser());
    await user.type(identifier, "ana");
    await user.type(password, "correct horse");
    await user.click(screen.getByRole("button", { name: t("login") }));
    expect(await screen.findByText("The library")).toBeInTheDocument();
    expect(location()).toBe("/app");
    expect(server.requests("POST", "/auth/login")[0].body).toEqual({
      username_or_email: "ana",
      password: "correct horse",
    });
    expect(getAccessToken()).toBe(TOKEN);
    expect(server.requests("GET", "/auth/me")[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    // Nothing of the session is written where a script could read it later.
    for (const storage of [localStorage, sessionStorage]) {
      const values = Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i) ?? ""));
      expect(values.join(" ")).not.toContain(TOKEN);
    }
    expect(localStorage.getItem("liveface.tokens")).toBeNull();
    expect(document.cookie).not.toContain(TOKEN);
  });

  it("a refused sign-in is said in an alert, and the form stays", async () => {
    const { user, identifier, password, server } = setup();
    server.on("POST", "/auth/login", () => apiError(401, "invalid_credentials", "Wrong username or password"));
    await user.type(identifier, "ana");
    await user.type(password, "nope");
    await user.click(screen.getByRole("button", { name: t("login") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password");
    expect(getAccessToken()).toBeNull();
    expect(identifier).toHaveValue("ana");
  });
  it("passes axe, with its errors showing", async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole("button", { name: t("login") }));
    await screen.findAllByRole("alert");
    await expectAccessible(container);
  });
});
