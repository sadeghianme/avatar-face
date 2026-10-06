import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AvatarDetailPage } from "@/features/avatars";
import { translate } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { mockConsent, mockSpeech } from "@/test/api";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

// The stage is the engine on a canvas: stood in for by a marker.
vi.mock("@/features/avatars/components/AvatarPreview", () => ({
  AvatarPreview: ({ rigUrl }: { rigUrl: string }) => <div data-testid="stage" data-rig={rigUrl} />,
}));
vi.mock("@/features/avatars/components/Avatar3DPreview", () => ({
  Avatar3DPreview: () => <div data-testid="stage-3d" />,
}));

const t = translate;
const AVATAR = `/orgs/${ORG_ID}/avatars/av1`;

function setup(avatar: Avatar | (() => Avatar | Response), prepare?: (server: MockServer) => void) {
  const server = createServer();
  mockConsent(server);
  mockSpeech(server);
  server
    .on("GET", AVATAR, typeof avatar === "function" ? avatar : () => avatar)
    .on("GET", `${AVATAR}/mouth-kit`, () => ({ job: null }))
    .on("GET", `/orgs/${ORG_ID}/avatars`, () => []);
  prepare?.(server);
  return renderScreen(<AvatarDetailPage />, {
    route: "/avatars/av1",
    path: "/avatars/:avatarId",
    server,
    routes: { "/app": <p>The library</p>, "/avatars/new/:id": <p>The wizard</p> },
  });
}

/** The settings column's folding sections, by their title. */
const section = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });

describe("AvatarDetailPage", () => {
  it("shows the avatar: its name, its state, the stage and the settings", async () => {
    setup(anAvatar());
    expect(await screen.findByRole("button", { name: `Maya. ${t("wzRename")}` })).toBeInTheDocument();
    expect(screen.getByText(t("status.ready"))).toBeInTheDocument();
    expect(screen.getByTestId("stage")).toHaveAttribute("data-rig", anAvatar().rig_url);
    expect(screen.getByRole("link", { name: t("avatars") })).toHaveAttribute("href", "/app");
    expect(screen.getByRole("link", { name: t("testInSimulator") })).toHaveAttribute("href", "/simulator?avatar=av1");
  });

  it("an avatar that is not there says so", async () => {
    setup(() => apiError(404, "avatar_not_found"));
    expect(await screen.findByText(new RegExp(t("error")))).toBeInTheDocument();
  });

  it("the sections fold and unfold, Framing open to start, and are remembered", async () => {
    const { user } = setup(anAvatar());
    await screen.findByTestId("stage");
    expect(section(t("sceneTitle"))).toHaveAttribute("aria-expanded", "true");
    const mouth = section(t("mouthTitle"));
    expect(mouth).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("mouth-section")).not.toBeVisible();
    await user.click(mouth);
    expect(mouth).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("mouth-section")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("liveface.avatarPage.open") ?? "{}")).toMatchObject({ mouth: true });
    await user.click(section(t("embedSnippet")));
    expect(section(t("embedSnippet"))).toHaveAttribute("aria-expanded", "true");
    await user.click(mouth);
    expect(mouth).toHaveAttribute("aria-expanded", "false");
  });

  it("a live avatar's bar says so and offers nothing to publish", async () => {
    setup(anAvatar());
    const bar = await screen.findByText(t("publishLiveTitle"));
    expect(bar.closest("[role=status]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: t("publish") })).not.toBeInTheDocument();
  });

  it("a draft with changes: Publish sends it and the bar turns live", async () => {
    let published = false;
    const { user, server } = setup(
      () => anAvatar({ unpublished: !published }),
      (s) =>
        s.on("POST", `${AVATAR}/publish`, () => {
          published = true;
          return anAvatar();
        })
    );
    const bar = (await screen.findByText(t("publishDraftTitle"))).closest("[role=status]") as HTMLElement;
    expect(within(bar).getByRole("button", { name: t("publishDiscard") })).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: t("publish") }));
    expect(await screen.findByText(t("publishLiveTitle"))).toBeInTheDocument();
    expect(server.requests("POST", `${AVATAR}/publish`)).toHaveLength(1);
  });

  it("a refused publish is said under the bar", async () => {
    const { user } = setup(anAvatar({ published: false, unpublished: true }), (s) =>
      s.on("POST", `${AVATAR}/publish`, () => apiError(409, "rig_missing", "Build the avatar first"))
    );
    const bar = (await screen.findByText(t("publishFirstTitle"))).closest("[role=status]") as HTMLElement;
    // Never published: nothing to discard back to.
    expect(within(bar).queryByRole("button", { name: t("publishDiscard") })).not.toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: t("publish") }));
    expect(await within(bar).findByText("Build the avatar first")).toBeInTheDocument();
  });

  it("Delete asks once, in place, then deletes and goes back to the library", async () => {
    const { user, server, location } = setup(anAvatar(), (s) => s.on("DELETE", AVATAR, () => undefined));
    await user.click(await screen.findByRole("button", { name: t("delete") }));
    const question = screen.getByRole("group", { name: t("deleteAsk") });
    expect(within(question).getByRole("button", { name: t("cancel") })).toHaveFocus();
    expect(server.requests("DELETE", AVATAR)).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: t("delete") }));
    expect(await screen.findByText("The library")).toBeInTheDocument();
    expect(location()).toBe("/app");
    expect(server.requests("DELETE", AVATAR)).toHaveLength(1);
  });

  it("Delete cancelled deletes nothing", async () => {
    const { user, server } = setup(anAvatar());
    await user.click(await screen.findByRole("button", { name: t("delete") }));
    await user.click(screen.getByRole("button", { name: t("cancel") }));
    expect(screen.queryByRole("group", { name: t("deleteAsk") })).not.toBeInTheDocument();
    expect(server.requests("DELETE", AVATAR)).toHaveLength(0);
  });

  it("renames in place", async () => {
    const { user, server } = setup(anAvatar(), (s) =>
      s.on("PATCH", AVATAR, (request) => anAvatar(request.body as Partial<Avatar>))
    );
    await user.click(await screen.findByRole("button", { name: `Maya. ${t("wzRename")}` }));
    const field = screen.getByRole("textbox", { name: t("wzRenameLabel") });
    await user.clear(field);
    await user.type(field, "Maya Lopez{Enter}");
    await waitFor(() => expect(server.requests("PATCH", AVATAR)).toHaveLength(1));
    expect(server.requests("PATCH", AVATAR)[0].body).toEqual({ name: "Maya Lopez" });
  });

  it("a failed build says why and runs again on Retry; a refused retry is said", async () => {
    const { user, server } = setup(anAvatar({ status: "failed", error: "No face found", rig_url: null }), (s) =>
      s.on("POST", `${AVATAR}/retry`, () => apiError(429, "too_many_jobs", "Busy", {}, { "Retry-After": "30" }))
    );
    expect(await screen.findByText("No face found")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("retry") }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(server.requests("POST", `${AVATAR}/retry`)).toHaveLength(1);
  });

  it("an avatar the wizard is still building points there", async () => {
    setup(anAvatar({ status: "processing", preparing_creation_id: "c9", rig_url: null }));
    const follow = await screen.findByRole("link", { name: t("avatarPreparingFollow") });
    expect(follow).toHaveAttribute("href", "/avatars/new/c9");
    expect(screen.queryByTestId("stage")).not.toBeInTheDocument();
  });

  it("a quality note offers to mark the face", async () => {
    setup(anAvatar({ quality_note: "The eyes may be off." }));
    expect(await screen.findByText("The eyes may be off.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: t("markFace") }).length).toBeGreaterThan(1);
  });

  it("the voice picked is saved to the draft", async () => {
    const { user, server } = setup(anAvatar(), (s) =>
      s.on("PATCH", AVATAR, (request) => anAvatar(request.body as Partial<Avatar>))
    );
    await screen.findByTestId("stage");
    const voice = await screen.findByRole("combobox", { name: t("voice") });
    await within(voice).findByRole("option", { name: /Heart/ });
    await user.selectOptions(voice, "af_heart");
    await waitFor(() => expect(server.requests("PATCH", AVATAR).length).toBeGreaterThan(0));
    expect(server.requests("PATCH", AVATAR).at(-1)?.body).toMatchObject({ voice: { voice: "af_heart" } });
  });
});
