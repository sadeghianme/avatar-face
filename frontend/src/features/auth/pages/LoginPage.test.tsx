import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/features/auth";
import i18n from "@/i18n";
import { getTokens } from "@/lib/api";
import { aUser } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer } from "@/test/server";

// The live avatar beside the form is the engine on a canvas: not this test's.
vi.mock("@/components/brand/DemoAvatar", () => ({ DEMO_PORTRAIT: "", DemoAvatar: () => null }));

const t = i18n.t.bind(i18n);

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
    expect(server.requests("POST", "/auth/login")).toHaveLength(0);
  });

  it("signs in, keeps the session and goes to the library", async () => {
    const { user, identifier, password, server, location } = setup();
    server
      .on("POST", "/auth/login", () => ({ access_token: "a1", refresh_token: "r1", token_type: "bearer" }))
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
    expect(getTokens()).toEqual({ access_token: "a1", refresh_token: "r1", token_type: "bearer" });
  });

  it("a refused sign-in is said in an alert, and the form stays", async () => {
    const { user, identifier, password, server } = setup();
    server.on("POST", "/auth/login", () => apiError(401, "invalid_credentials", "Wrong username or password"));
    await user.type(identifier, "ana");
    await user.type(password, "nope");
    await user.click(screen.getByRole("button", { name: t("login") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password");
    expect(getTokens()).toBeNull();
    expect(identifier).toHaveValue("ana");
  });
});
