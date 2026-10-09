import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AvatarsPage } from "@/features/avatars";
import { translate } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { expectAccessible } from "@/test/axe";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = translate;

function setup(avatars: Avatar[] | ((server: MockServer) => void)) {
  const server = createServer();
  server
    .on("GET", `/orgs/${ORG_ID}/usage`, () => ({
      month_start: "2026-10-01",
      chars_used: 250,
      char_limit: 1000,
      by_provider: [],
    }))
    .on("GET", `/orgs/${ORG_ID}/creations`, () => [])
    .on("GET", `/orgs/${ORG_ID}/avatars/:id`, (_, { id }) => anAvatar({ id }));
  if (typeof avatars === "function") avatars(server);
  else server.on("GET", `/orgs/${ORG_ID}/avatars`, () => avatars);
  return renderScreen(<AvatarsPage />, { route: "/app", path: "/app", server });
}

describe("AvatarsPage", () => {
  it("with no avatars: says so and offers a fresh start", async () => {
    setup([]);
    expect(await screen.findByRole("heading", { name: t("emptyTitle") })).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: t("newAvatar") });
    for (const link of links) expect(link).toHaveAttribute("href", "/avatars/new");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists the avatars, counted, each a link to its page, with the usage", async () => {
    setup([
      anAvatar({ id: "a1", name: "Maya" }),
      anAvatar({ id: "a2", name: "Leo", status: "processing" }),
      anAvatar({ id: "a3", name: "Zed", status: "failed", error: "No face" }),
    ]);
    const maya = await screen.findByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) });
    expect(maya).toHaveAttribute("href", "/avatars/a1");
    expect(screen.getByRole("link", { name: t("openAvatarNamed", { name: "Leo" }) })).toBeInTheDocument();
    expect(screen.getByText(t("avatarCount", { count: 3 }))).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: t("overview") });
    expect(within(overview).getByText("25%")).toBeInTheDocument();
  });

  it("searches and filters the list, and says when nothing matches", async () => {
    const { user } = setup([
      anAvatar({ id: "a1", name: "Maya" }),
      anAvatar({ id: "a2", name: "Leo", status: "failed", error: "No face" }),
    ]);
    await screen.findByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) });
    await user.click(screen.getByRole("button", { name: new RegExp(t("status.failed")) }));
    expect(screen.queryByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("openAvatarNamed", { name: "Leo" }) })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(t("filterAll")) }));
    await user.type(screen.getByRole("searchbox", { name: t("searchAvatars") }), "zzz");
    expect(screen.getByRole("heading", { name: t("noAvatarMatches") })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("clearFilters") }));
    expect(screen.getByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) })).toBeInTheDocument();
  });

  it("a list that cannot be loaded says so, not 'no avatars', and tries again", async () => {
    let fail = true;
    const { user } = setup((server) =>
      server.on("GET", `/orgs/${ORG_ID}/avatars`, () => (fail ? apiError(500, "http_500") : [anAvatar()]))
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("avatarsLoadFailed"));
    expect(screen.queryByRole("heading", { name: t("emptyTitle") })).not.toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole("button", { name: t("retry") }));
    expect(await screen.findByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("passes axe with a list", async () => {
    const { container } = setup([anAvatar({ id: "a1", name: "Maya" }), anAvatar({ id: "a2", name: "Leo" })]);
    await screen.findByRole("link", { name: t("openAvatarNamed", { name: "Maya" }) });
    await expectAccessible(container);
  });
});
