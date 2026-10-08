/**
 * The page behind a share link, against its public endpoints: the
 * published avatar on the engine (stood in for), its name and AI
 * disclosure, a line said in the published voice (Play or Enter), the
 * browser's voice when the server has none, and a link that is gone.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SharePage } from "@/features/share";
import type { PublicAvatar, SpokenAudio } from "@/features/share/api";
import { translate } from "@/i18n";
import { expectAccessible } from "@/test/axe";
import { renderScreen } from "@/test/render";
import { apiError, createServer } from "@/test/server";

const engine = vi.hoisted(() => ({
  options: [] as unknown[],
  played: [] as string[],
  destroyed: 0,
  browserVoice: false,
}));

vi.mock("@liveface/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@liveface/embed")>()),
  AvatarEngine: class {
    constructor(_canvas: unknown, _rig: unknown, _texture: unknown, options: unknown) {
      engine.options.push(options);
    }
    playAudio(audio: string, _mime: string, _cues: unknown, done: () => void) {
      engine.played.push(audio);
      done();
    }
    setLayers() {}
    destroy() {
      engine.destroyed++;
    }
  },
  BrowserTTS: class {
    static supported() {
      return engine.browserVoice;
    }
    speak() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@/lib/image", () => ({ loadImage: () => Promise.resolve({}) }));

const t = translate;
const TOKEN = "tok1";

function published(extra: Partial<PublicAvatar> = {}): PublicAvatar {
  return {
    name: "Maya",
    kind: "photo",
    framing: "full",
    face_type: "human",
    scene: null,
    rig_url: "/api/storage/share/rig.json",
    image_url: "/api/storage/share/image.png",
    thumbnail_url: "/api/storage/share/thumb.png",
    model_url: null,
    layer_urls: null,
    voice: { provider: "kokoro", voice: "am_adam", locale: "en-GB" },
    mouth: null,
    disclosure: { ai_edited: { mode: "prepare", model: "gemini" }, line: "human" },
    ...extra,
  };
}

function setup(avatar: PublicAvatar | null = published()) {
  const server = createServer();
  server
    .on("GET", `/public/v1/avatars/${TOKEN}`, () => avatar ?? apiError(404, "not_found"))
    .on("GET", "/storage/share/rig.json", () => ({ version: 1 }))
    .on("POST", `/public/v1/avatars/${TOKEN}/speak`, (): SpokenAudio => ({
      audio_b64: "UklGRg==",
      audio_mime: "audio/wav",
      duration_ms: 400,
      cues: [],
    }));
  return renderScreen(<SharePage />, { route: `/s/${TOKEN}`, path: "/s/:token", signedIn: false, server });
}

describe("the share page", () => {
  beforeEach(() => {
    engine.options = [];
    engine.played = [];
    engine.destroyed = 0;
    engine.browserVoice = false;
  });

  it("shows the published avatar: its name, the AI disclosure, and the engine on its face type and scene", async () => {
    const view = setup();
    expect(await screen.findByRole("heading", { name: "Maya" })).toBeInTheDocument();
    expect(screen.getByText(t("shareAiAvatar"))).toBeInTheDocument();
    await waitFor(() => expect(engine.options).toHaveLength(1));
    expect(engine.options[0]).toMatchObject({ fullPhoto: true, faceType: "human", debug: true });
    await expectAccessible(view.container);
    view.unmount();
    expect(engine.destroyed).toBe(1);
  });

  it("Play says the line in the published voice", async () => {
    const view = setup();
    const play = await screen.findByRole("button", { name: t("sharePlay") });
    expect(play).toBeDisabled();
    await waitFor(() => expect(engine.options).toHaveLength(1));
    await view.user.type(screen.getByPlaceholderText(t("sharePlaceholder")), "Hello there");
    await view.user.click(play);
    await waitFor(() => expect(engine.played).toEqual(["UklGRg=="]));
    const [request] = view.server.requests("POST", `/public/v1/avatars/${TOKEN}/speak`);
    expect(request.body).toEqual({ text: "Hello there", provider: "kokoro", voice: "am_adam", locale: "en-GB" });
  });

  it("Enter says the line; Shift+Enter is a new line", async () => {
    const view = setup(published({ voice: { provider: "browser", voice: "x", locale: "fr-FR" } }));
    await waitFor(() => expect(engine.options).toHaveLength(1));
    const box = screen.getByPlaceholderText(t("sharePlaceholder"));
    await view.user.type(box, "One{Shift>}{Enter}{/Shift}two");
    expect(box).toHaveValue("One\ntwo");
    expect(view.server.requests("POST", `/public/v1/avatars/${TOKEN}/speak`)).toHaveLength(0);
    await view.user.type(box, "{Enter}");
    await waitFor(() => expect(engine.played).toHaveLength(1));
    // A browser voice cannot be made on the server: its default speaks.
    expect(view.server.requests("POST", `/public/v1/avatars/${TOKEN}/speak`)[0].body).toMatchObject({
      provider: "kokoro",
      voice: "af_heart",
      locale: "en-US",
    });
  });

  it("with no server voice and none in the browser, says so", async () => {
    const view = setup();
    view.server.on("POST", `/public/v1/avatars/${TOKEN}/speak`, () => apiError(503, "tts_unavailable"));
    await waitFor(() => expect(engine.options).toHaveLength(1));
    await view.user.type(screen.getByPlaceholderText(t("sharePlaceholder")), "Hello{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(t("shareNoVoice"));
    expect(engine.played).toEqual([]);
  });

  it("a link that is gone says so", async () => {
    setup(null);
    expect(await screen.findByRole("heading", { name: t("shareGoneTitle") })).toBeInTheDocument();
    expect(screen.getByText(t("shareGoneBody"))).toBeInTheDocument();
    expect(engine.options).toHaveLength(0);
  });
});
