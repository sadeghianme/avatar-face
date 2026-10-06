import { DEFAULT_REFERENCE_PROFILE } from "@liveface/embed/mouth";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MouthPanel } from "@/features/avatars/components/MouthPanel";
import type { MotionChoice } from "@/features/avatars/mouth-config";
import { translate } from "@/i18n";
import type { Avatar, MouthKit } from "@/lib/types";
import { mockConsent } from "@/test/api";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = translate;
const AVATAR = `/orgs/${ORG_ID}/avatars/av1`;

type Mouth = NonNullable<Avatar["mouth"]>;
const photographic = (extra: Partial<Mouth> = {}): Mouth => ({
  renderer: "continuous",
  profile: { ...DEFAULT_REFERENCE_PROFILE },
  has_oral_photo: false,
  teeth: { source: null, note: null },
  motion_url: null,
  kit: null,
  ...extra,
});
const ownKit = (): MouthKit => ({
  state: "made",
  made_at: "2026-10-05T10:00:00Z",
  model: "gemini",
  generated: 6,
  retargeted: 0,
  shapes: (["aa", "ee", "oo", "oh", "fv", "th"] as const).map((shape) => ({
    shape,
    provenance: "generated" as const,
    reason: null,
  })),
  teeth: { used: true, reason: null },
  dropped: null,
});

function setup(avatar: Avatar, prepare?: (server: MockServer) => void) {
  const server = createServer();
  mockConsent(server);
  server
    .on("GET", `${AVATAR}/mouth-kit`, () => ({ job: null }))
    .on("PATCH", AVATAR, (request) => ({ ...avatar, ...(request.body as object) }));
  prepare?.(server);
  const onPreview = vi.fn();
  const onPreviewCharacter = vi.fn();
  const onMotion = vi.fn();
  function Panel() {
    const [motion, setMotion] = useState<MotionChoice>("own");
    return (
      <MouthPanel
        avatar={avatar}
        orgId={ORG_ID}
        onPreview={onPreview}
        onPreviewCharacter={onPreviewCharacter}
        motion={motion}
        onMotion={(choice) => {
          onMotion(choice);
          setMotion(choice);
        }}
      />
    );
  }
  const result = renderScreen(<Panel />, { server });
  return { ...result, onPreview, onPreviewCharacter, onMotion };
}

describe("MouthPanel", () => {
  it("a person: Classic or Photographic, one tab stop, the saved one chosen", () => {
    setup(anAvatar());
    const group = screen.getByRole("radiogroup", { name: t("mouthTitle") });
    const classic = within(group).getByRole("radio", { name: new RegExp(t("mouthClassic")) });
    const photo = within(group).getByRole("radio", { name: new RegExp(t("mouthContinuous")) });
    expect(classic).toHaveAttribute("aria-checked", "true");
    expect(photo).toHaveAttribute("tabindex", "-1");
    // The classic mouth has no teeth or sliders.
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("choosing Photographic previews it and saves it as a draft", async () => {
    const { user, server, onPreview } = setup(anAvatar());
    await user.click(screen.getByRole("radio", { name: new RegExp(t("mouthContinuous")) }));
    expect(onPreview).toHaveBeenCalledWith("continuous", expect.objectContaining({ teethScale: expect.any(Number) }));
    await waitFor(() => expect(server.requests("PATCH", AVATAR)).toHaveLength(1));
    expect(server.requests("PATCH", AVATAR)[0].body).toEqual({
      mouth: { renderer: "continuous", profile: expect.any(Object) },
    });
  });

  it("an animal: one choice, said to be the only one, and the character's own settings", () => {
    setup(anAvatar({ face_type: "animal" }));
    expect(screen.getByText(t("mouthHumanOnly"))).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: new RegExp(t("mouthContinuous")) })).not.toBeInTheDocument();
  });

  it("the sliders preview as they move and save when let go; Reset saves the defaults", async () => {
    const { user, server, onPreview } = setup(anAvatar({ mouth: photographic() }));
    const sliders = screen.getAllByRole("slider");
    expect(sliders).toHaveLength(4);
    const jaw = screen.getByRole("slider", { name: new RegExp(t("mouthJaw")) });
    fireEvent.change(jaw, { target: { value: String(Number(jaw.getAttribute("max"))) } });
    expect(onPreview).toHaveBeenLastCalledWith(
      "continuous",
      expect.objectContaining({ jawRange: Number(jaw.getAttribute("max")) })
    );
    expect(server.requests("PATCH", AVATAR)).toHaveLength(0);
    fireEvent.pointerUp(jaw);
    await waitFor(() => expect(server.requests("PATCH", AVATAR)).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: t("mouthReset") }));
    await waitFor(() => expect(server.requests("PATCH", AVATAR)).toHaveLength(2));
    expect(server.requests("PATCH", AVATAR)[1].body).toEqual({
      mouth: { renderer: "continuous", profile: DEFAULT_REFERENCE_PROFILE },
    });
  });

  it("a refused save is said in an alert", async () => {
    const { user } = setup(anAvatar(), (server) =>
      server.on("PATCH", AVATAR, () => apiError(409, "draft_conflict", "Someone else changed it"))
    );
    await user.click(screen.getByRole("radio", { name: new RegExp(t("mouthContinuous")) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed it");
  });

  it("an uploaded teeth photo is followed by a Publish prompt beside it", async () => {
    const avatar = anAvatar({ mouth: photographic(), unpublished: true });
    const { user, server, container } = setup(avatar, (s) =>
      s
        .on("POST", `${AVATAR}/mouth-photo`, () => avatar)
        .on("POST", `${AVATAR}/publish`, () => ({ ...avatar, unpublished: false }))
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(["jpg"], "teeth.jpg", { type: "image/jpeg" }));
    expect(await screen.findByText(t("mouthTeethMade"), { selector: "p:not(.sr-only)" })).toBeInTheDocument();
    expect(server.requests("POST", `${AVATAR}/mouth-photo`)[0].body).toBeInstanceOf(FormData);
    // The live region says it too.
    expect(screen.getByRole("status")).toHaveTextContent(t("mouthTeethMade"));
    await user.click(screen.getByRole("button", { name: t("publish") }));
    await waitFor(() => expect(server.requests("POST", `${AVATAR}/publish`)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByText(t("mouthTeethMade"), { selector: "p:not(.sr-only)" })).not.toBeInTheDocument()
    );
  });

  it("a refused teeth photo is said in the panel's own words, beside its buttons", async () => {
    const { user, container } = setup(anAvatar({ mouth: photographic() }), (s) =>
      s.on("POST", `${AVATAR}/mouth-photo`, () => apiError(422, "reference_no_face", "no face"))
    );
    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["jpg"], "teeth.jpg", { type: "image/jpeg" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(t("mouthErr_upload_reference_no_face"));
  });

  it("removes the owner's teeth photo", async () => {
    const avatar = anAvatar({ mouth: photographic({ has_oral_photo: true, teeth: { source: "upload", note: null } }) });
    const { user, server } = setup(avatar, (s) => s.on("DELETE", `${AVATAR}/mouth-photo`, () => avatar));
    expect(screen.getByRole("button", { name: t("mouthPhotoReplace") })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("mouthPhotoRemove") }));
    await waitFor(() => expect(server.requests("DELETE", `${AVATAR}/mouth-photo`)).toHaveLength(1));
  });

  it("makes the mouth shapes and teeth with AI: the job's stage, then a Publish prompt", async () => {
    const avatar = anAvatar({ mouth: photographic(), unpublished: true });
    const running = {
      id: "kit1",
      step: "mouth_kit",
      state: "running",
      error: null,
      started_at: "2026-10-06T10:00:00Z",
      progress: { fraction: 0.3, label: "making the mouth shapes", count: { done: 2, total: 6 } },
      retryable: false,
    };
    let polled = 0;
    const { user, server } = setup(avatar, (s) =>
      s
        .on("POST", `${AVATAR}/mouth-kit`, () => ({ job: running }))
        .on("GET", `${AVATAR}/mouth-kit`, () =>
          polled++ === 0 ? { job: null } : { job: { ...running, state: "done", progress: null } }
        )
    );
    await user.click(await screen.findByRole("button", { name: t("mouthKitMake") }));
    await waitFor(() => expect(server.requests("POST", `${AVATAR}/mouth-kit`)).toHaveLength(1));
    expect(server.requests("POST", `${AVATAR}/mouth-kit`)[0].body).toEqual({ consent_id: "consent-ai" });
    expect(await screen.findByText(t("mouthKitStage_shapesTeeth"), { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(t("mouthShapesCount", { done: 2, total: 6 }), { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    // Polled until it ends: then the prompt to publish what it made.
    expect(
      await screen.findByText(t("mouthTeethMade"), { selector: "p:not(.sr-only)" }, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("publish") })).toBeInTheDocument();
  });

  it("a kit that cannot start says why", async () => {
    const { user } = setup(anAvatar({ mouth: photographic() }), (s) =>
      s.on("POST", `${AVATAR}/mouth-kit`, () => apiError(503, "imagegen_unavailable", "down"))
    );
    await user.click(await screen.findByRole("button", { name: t("mouthKitMake") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("mouthErr_imagegen_unavailable"));
  });

  it("with the organization's AI off, offers no kit", async () => {
    const server = createServer();
    mockConsent(server, { aiEnabled: false });
    server.on("GET", `${AVATAR}/mouth-kit`, () => ({ job: null }));
    renderScreen(
      <MouthPanel
        avatar={anAvatar({ mouth: photographic() })}
        orgId={ORG_ID}
        onPreview={() => undefined}
        onPreviewCharacter={() => undefined}
        motion="own"
        onMotion={() => undefined}
      />,
      { server }
    );
    await waitFor(() => expect(server.requests("GET", `/orgs/${ORG_ID}/consents/terms`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: t("mouthKitMake") })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: t("mouthPhotoAdd") })).toBeInTheDocument();
  });

  it("the avatar's own shapes can be compared with the standard ones in the preview", async () => {
    const { user, onMotion } = setup(
      anAvatar({
        mouth: photographic({
          motion_url: "/api/storage/motion.json",
          kit: ownKit(),
          has_oral_photo: true,
          teeth: { source: "ai", note: null },
        }),
      })
    );
    const compare = screen.getByRole("radiogroup", { name: t("mouthCompare") });
    expect(within(compare).getByRole("radio", { name: t("mouthCompare_own") })).toHaveAttribute("aria-checked", "true");
    await user.click(within(compare).getByRole("radio", { name: t("mouthCompare_standard") }));
    expect(onMotion).toHaveBeenCalledWith("standard");
    // Own teeth made by AI: the kit makes the shapes and teeth.
    expect(screen.getByRole("button", { name: t("mouthKitMake") })).toBeInTheDocument();
  });
});
