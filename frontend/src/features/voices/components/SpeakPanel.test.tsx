/**
 * The Speak panel on its own (the face panel's, the avatar page's): the
 * sample in the chosen language until the member types, the line streamed
 * in the server's voice, Stop, and a refusal said under the box.
 */
import type { SpeechPlayer } from "@liveface/embed";
import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SpeakPanel, type VoiceSelection } from "@/features/voices";
import { translate } from "@/i18n";
import { ApiError } from "@/lib/api";
import { mockSpeech } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { createServer } from "@/test/server";

const speech = vi.hoisted(() => ({
  said: [] as string[],
  stopped: 0,
  /** What the next stream's `done` does: resolve, or fail with this. */
  failWith: null as unknown,
  /** Holds the next stream open until released. */
  hold: null as null | (() => void),
}));

vi.mock("@liveface/embed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@liveface/embed")>()),
  sttSupported: () => false,
  StreamingSpeechPlayer: class {
    unlock() {
      return Promise.resolve();
    }
  },
  streamSpeech: (_engine: unknown, request: () => Promise<Response>) => {
    void request();
    return {
      done:
        speech.failWith !== null
          ? Promise.reject(speech.failWith)
          : new Promise<void>((resolve) => {
              speech.hold = resolve;
            }),
      stop: () => {
        speech.stopped++;
        speech.hold?.();
      },
    };
  },
}));

const t = translate;
const ENGINE = {} as SpeechPlayer;

function Panel({ engine = ENGINE }: { engine?: SpeechPlayer | null }) {
  const [selection, setSelection] = useState<VoiceSelection>({
    provider: "kokoro",
    voice: "af_heart",
    locale: "en-US",
  });
  return (
    <>
      <button type="button" onClick={() => setSelection({ provider: "kokoro", voice: "ff_siwis", locale: "fr-FR" })}>
        French
      </button>
      <SpeakPanel engine={engine} orgId={ORG_ID} selection={selection} onSelectionChange={setSelection} />
    </>
  );
}

function setup(engine?: SpeechPlayer | null) {
  const server = createServer();
  mockSpeech(server);
  server
    .on("GET", "/tts/languages", () => [
      {
        locale: "en-US",
        name: "English",
        native_name: "English",
        sample: "Hello there",
        provider: "kokoro",
        voice: "af_heart",
      },
      {
        locale: "fr-FR",
        name: "French",
        native_name: "Français",
        sample: "Bonjour",
        provider: "kokoro",
        voice: "ff_siwis",
      },
    ])
    .on("POST", `/tts/orgs/${ORG_ID}/stream`, (request) => {
      speech.said.push((request.body as { text: string }).text);
      return new Response("", { status: 200 });
    });
  return renderScreen(<Panel engine={engine} />, { server });
}

describe("the Speak panel", () => {
  beforeEach(() => {
    speech.said = [];
    speech.stopped = 0;
    speech.failWith = null;
    speech.hold = null;
  });

  it("offers a sample in the chosen language, and follows the language until the member types", async () => {
    const view = setup();
    const box = screen.getByRole("textbox", { name: t("speakPlaceholder") });
    await waitFor(() => expect(box).toHaveValue("Hello there"));
    await view.user.click(screen.getByRole("button", { name: "French" }));
    await waitFor(() => expect(box).toHaveValue("Bonjour"));
    await view.user.clear(box);
    await view.user.type(box, "My own words");
    await view.user.click(screen.getByRole("button", { name: "French" }));
    expect(box).toHaveValue("My own words");
    await expectAccessible(view.container);
  });

  it("Speak streams the line in the server's voice; Stop ends it", async () => {
    const view = setup();
    const speak = screen.getByRole("button", { name: t("speak") });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: t("speakPlaceholder") })).toHaveValue("Hello there")
    );
    await view.user.click(speak);
    await waitFor(() => expect(speech.said).toEqual(["Hello there"]));
    expect(speak).toBeDisabled();
    await view.user.click(screen.getByRole("button", { name: t("stop") }));
    expect(speech.stopped).toBe(1);
    await waitFor(() => expect(speak).toBeEnabled());
  });

  it("a refused line is said under the box", async () => {
    speech.failWith = new ApiError(429, "rate_limited", "Too many requests today");
    const view = setup();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: t("speakPlaceholder") })).toHaveValue("Hello there")
    );
    await view.user.click(screen.getByRole("button", { name: t("speak") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests today");
  });

  it("with no engine yet, nothing can be said", () => {
    setup(null);
    expect(screen.getByRole("button", { name: t("speak") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("stop") })).toBeDisabled();
  });
});
