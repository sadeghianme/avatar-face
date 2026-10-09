import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionsCard } from "@/features/settings/components/SessionsCard";
import { translate } from "@/i18n";
import { getAccessToken } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { expectAccessible } from "@/test/axe";
import { renderScreen } from "@/test/render";
import { apiError, createServer } from "@/test/server";

const t = translate;

function Who() {
  const { user } = useAuth();
  return <p>{user ? `signed in as ${user.username}` : "signed out"}</p>;
}

function setup(server = createServer()) {
  return renderScreen(
    <>
      <SessionsCard />
      <Who />
    </>,
    { route: "/settings", server }
  );
}

describe("SessionsCard", () => {
  it("asks once, then every session of the account ends and nobody is signed in here", async () => {
    const server = createServer().on("POST", "/auth/logout-all", () => undefined);
    const { user, container } = setup(server);
    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();
    await expectAccessible(container);

    await user.click(screen.getByRole("button", { name: t("logoutEverywhere") }));
    const question = screen.getByRole("group", { name: t("logoutEverywhereAsk") });
    expect(server.requests("POST", "/auth/logout-all")).toHaveLength(0);
    expect(question).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: t("logoutEverywhere") }).at(-1)!);
    expect(await screen.findByText("signed out")).toBeInTheDocument();
    const [request] = server.requests("POST", "/auth/logout-all");
    // The bearer token authorizes it, never the cookie alone.
    expect(request.headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(getAccessToken()).toBeNull();
  });

  it("a refusal says so, and this session stays", async () => {
    const server = createServer().on("POST", "/auth/logout-all", () => apiError(503, "service_unavailable"));
    const { user } = setup(server);
    expect(await screen.findByText("signed in as ana")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("logoutEverywhere") }));
    await user.click(screen.getAllByRole("button", { name: t("logoutEverywhere") }).at(-1)!);
    expect(await screen.findByText(t("logoutEverywhereFailed"))).toBeInTheDocument();
    expect(screen.getByText("signed in as ana")).toBeInTheDocument();
    expect(getAccessToken()).toBe("test-access-token");
  });
});
