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
  /** Each played line's expression track. */
  tracks: [] as unknown[],
  destroyed: 0,
  browserVoice: false,
}));

vi.mock("@liveface/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@liveface/embed")>()),
  AvatarEngine: class {
    constructor(_canvas: unknown, _rig: unknown, _texture: unknown, options: unknown) {
      engine.options.push(options);
    }
    playAudio(audio: string, _mime: string, _cues: unknown, done: () => void, track?: unknown) {
      engine.played.push(audio);
      engine.tracks.push(track);
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
    engine.tracks = [];
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

  it("keeps a line's expression tags from the voice and plays them on the face", async () => {
    const view = setup();
    const play = await screen.findByRole("button", { name: t("sharePlay") });
    await waitFor(() => expect(engine.options).toHaveLength(1));
    // userEvent reads "[" as a key descriptor: "[[" types one.
    await view.user.type(screen.getByPlaceholderText(t("sharePlaceholder")), "[[happy] Hello there");
    await view.user.click(play);
    await waitFor(() => expect(engine.played).toHaveLength(1));
    const [request] = view.server.requests("POST", `/public/v1/avatars/${TOKEN}/speak`);
    expect(request.body).toMatchObject({ text: "Hello there" });
    expect(engine.tracks[0]).toEqual([
      { t: 0, name: "happy", intensity: 1 },
      { t: 400, name: "neutral", intensity: 0 },
    ]);
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

  it("a line the cloned voice was never given is said in the server's voice for its language", async () => {
    const cloned = { provider: "cloned", voice: "org1:Mehdi voice", locale: "fr-FR" };
    const view = setup(published({ voice: cloned }));
    view.server
      .on("POST", `/public/v1/avatars/${TOKEN}/speak`, (request) =>
        (request.body as { provider: string }).provider === "cloned"
          ? apiError(404, "cloned_line_missing", "This line has not been rendered in the cloned voice yet.")
          : { audio_b64: "U0VSVkVS", audio_mime: "audio/wav", duration_ms: 400, cues: [] }
      )
      .on("GET", "/tts/languages", () => [
        {
          locale: "en-US",
          name: "English",
          native_name: "English",
          sample: "Hi",
          provider: "kokoro",
          voice: "af_heart",
        },
        {
          locale: "fr-FR",
          name: "French",
          native_name: "Français",
          sample: "Salut",
          provider: "kokoro",
          voice: "ff_siwis",
        },
      ]);
    await waitFor(() => expect(engine.options).toHaveLength(1));
    await view.user.type(screen.getByPlaceholderText(t("sharePlaceholder")), "Something new{Enter}");
    await waitFor(() => expect(engine.played).toEqual(["U0VSVkVS"]));
    const asked = view.server.requests("POST", `/public/v1/avatars/${TOKEN}/speak`).map((r) => r.body);
    expect(asked).toEqual([
      { text: "Something new", ...cloned },
      { text: "Something new", provider: "kokoro", voice: "ff_siwis", locale: "fr-FR" },
    ]);
    // Nothing for the visitor to be told: the avatar spoke.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
