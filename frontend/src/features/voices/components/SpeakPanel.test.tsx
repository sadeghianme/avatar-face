/**
 * The Speak panel on its own (the face panel's, the avatar page's): the
 * sample in the chosen language until the member types, the line streamed
 * in the server's voice, Stop, and a refusal said under the box — in the
 * dashboard's words for the codes it knows. A cloned voice offers the lines
 * rendered in it; a line it was never given can be heard in a server voice
 * or sent to the Voices page to be rendered.
 */
import { SpeechError, type SpeechPlayer } from "@liveface/embed";
import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SpeakPanel, type VoiceSelection } from "@/features/voices";
import type { ClonedVoice, CloneJob } from "@/features/voices/api";
import { translate } from "@/i18n";
import { ApiError } from "@/lib/api";
import { mockSpeech } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { createServer } from "@/test/server";

const speech = vi.hoisted(() => ({
  said: [] as string[],
  /** Every stream's request body, in order. */
  asked: [] as unknown[],
  stopped: 0,
  /** What the next stream's `done` does: resolve, or fail with this (once). */
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
    const failure = speech.failWith;
    speech.failWith = null;
    return {
      done:
        failure !== null
          ? Promise.reject(failure)
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
const SERVER_VOICE: VoiceSelection = { provider: "kokoro", voice: "af_heart", locale: "en-US" };
const MEHDI = `${ORG_ID}:Mehdi voice`;
const CLONED: VoiceSelection = { provider: "cloned", voice: MEHDI, locale: "en-US" };

function Panel({
  engine = ENGINE,
  initial = SERVER_VOICE,
}: {
  engine?: SpeechPlayer | null;
  initial?: VoiceSelection;
}) {
  const [selection, setSelection] = useState<VoiceSelection>(initial);
  return (
    <>
      <button type="button" onClick={() => setSelection({ provider: "kokoro", voice: "ff_siwis", locale: "fr-FR" })}>
        French
      </button>
      <SpeakPanel engine={engine} orgId={ORG_ID} selection={selection} onSelectionChange={setSelection} />
    </>
  );
}

/** Where "Add it on the Voices page" lands: what it was handed. */
function VoicesProbe() {
  return <p data-testid="voices-page">{JSON.stringify(useLocation().state)}</p>;
}

function setup({
  engine,
  initial,
  jobs = [],
}: { engine?: SpeechPlayer | null; initial?: VoiceSelection; jobs?: CloneJob[] } = {}) {
  const server = createServer();
  mockSpeech(server);
  const mehdi: ClonedVoice = { voice: MEHDI, label: "Mehdi voice", lines: 2, total_ms: 3000, locale: "en-US" };
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
    .on("GET", `/orgs/${ORG_ID}/cloned-voices`, () => [mehdi])
    .on("GET", `/orgs/${ORG_ID}/clone-jobs`, () => jobs)
    .on("POST", `/tts/orgs/${ORG_ID}/stream`, (request) => {
      speech.said.push((request.body as { text: string }).text);
      speech.asked.push(request.body);
      return new Response("", { status: 200 });
    });
  return renderScreen(<Panel engine={engine} initial={initial} />, {
    server,
    routes: { "/voices": <VoicesProbe /> },
  });
}

const box = () => screen.getByRole("textbox", { name: t("speakPlaceholder") });

/** A done clone job of Mehdi's voice. */
const rendered = (lines: string[]): CloneJob => ({
  id: "j1",
  name: "Mehdi voice",
  locale: "en-US",
  lines,
  status: "done",
  error: null,
  done_lines: lines.length,
});

describe("the Speak panel", () => {
  beforeEach(() => {
    speech.said = [];
    speech.asked = [];
    speech.stopped = 0;
    speech.failWith = null;
    speech.hold = null;
  });

  it("offers a sample in the chosen language, and follows the language until the member types", async () => {
    const view = setup();
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
    await view.user.click(screen.getByRole("button", { name: "French" }));
    await waitFor(() => expect(box()).toHaveValue("Bonjour"));
    await view.user.clear(box());
    await view.user.type(box(), "My own words");
    await view.user.click(screen.getByRole("button", { name: "French" }));
    expect(box()).toHaveValue("My own words");
    await expectAccessible(view.container);
  });

  it("Speak streams the line in the server's voice; Stop ends it", async () => {
    const view = setup();
    const speak = screen.getByRole("button", { name: t("speak") });
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
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
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
    await view.user.click(screen.getByRole("button", { name: t("speak") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests today");
  });

  it("a refusal it has words for is said in them; one nothing explains, generically", async () => {
    speech.failWith = new SpeechError("usage_limit_reached", "Monthly character limit reached (10/10)", 429);
    const view = setup();
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
    const speak = screen.getByRole("button", { name: t("speak") });
    await view.user.click(speak);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("speechErr.usage_limit_reached"));
    // New words: what failed before is no longer the question.
    await view.user.type(box(), "!");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    speech.failWith = new TypeError("Failed to fetch");
    await view.user.click(speak);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("error"));
  });

  it("with no engine yet, nothing can be said", () => {
    setup({ engine: null });
    expect(screen.getByRole("button", { name: t("speak") })).toBeDisabled();
    expect(screen.getByRole("button", { name: t("stop") })).toBeDisabled();
  });
});

describe("the Speak panel with a cloned voice", () => {
  beforeEach(() => {
    speech.said = [];
    speech.asked = [];
    speech.failWith = null;
    speech.hold = null;
  });

  it("offers the lines rendered in it, starts on one, and says the one picked", async () => {
    const view = setup({
      initial: CLONED,
      jobs: [rendered(["Welcome! I'm glad you're here.", "How can I help you today?"])],
    });
    expect(await screen.findByText(t("speakClonedHint"))).toBeInTheDocument();
    // Not the language's sample, which this voice was never given.
    await waitFor(() => expect(box()).toHaveValue("Welcome! I'm glad you're here."));
    const lines = screen.getByRole("list", { name: t("speakClonedLines") });
    await view.user.click(within(lines).getByRole("button", { name: "How can I help you today?" }));
    expect(box()).toHaveValue("How can I help you today?");
    await view.user.click(screen.getByRole("button", { name: t("speak") }));
    await waitFor(() => expect(speech.asked).toEqual([{ text: "How can I help you today?", ...CLONED }]));
    await expectAccessible(view.container);
  });

  it("with no rendered line known, says what it can say and where lines are added", async () => {
    setup({ initial: CLONED });
    expect(await screen.findByText(t("speakClonedHint"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("speakClonedAddLines") })).toHaveAttribute("href", "/voices");
    expect(screen.queryByRole("list", { name: t("speakClonedLines") })).not.toBeInTheDocument();
  });

  it("a line it was never given is said so, and heard in a server voice without changing the voice", async () => {
    speech.failWith = new SpeechError(
      "cloned_line_missing",
      "This line has not been rendered in the cloned voice 'Mehdi voice' yet.",
      404
    );
    const view = setup({ initial: CLONED });
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
    await view.user.clear(box());
    await view.user.type(box(), "Something new");
    await view.user.click(screen.getByRole("button", { name: t("speak") }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(t("speechErr.cloned_line_missing"));
    await expectAccessible(view.container);
    await view.user.click(within(notice).getByRole("button", { name: t("speakUseServerVoice") }));
    await waitFor(() =>
      expect(speech.asked).toEqual([
        { text: "Something new", ...CLONED },
        { text: "Something new", ...SERVER_VOICE },
      ])
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The voice chosen (the avatar's, on its page) is still the clone.
    expect(screen.getByRole("combobox", { name: t("provider") })).toHaveValue("cloned");
  });

  it("a line it was never given can be sent to the Voices page, with the voice and the line", async () => {
    speech.failWith = new SpeechError("cloned_line_missing", "Not rendered.", 404);
    const view = setup({ initial: CLONED });
    await waitFor(() => expect(box()).toHaveValue("Hello there"));
    await view.user.click(screen.getByRole("button", { name: t("speak") }));
    const notice = await screen.findByRole("alert");
    await view.user.click(within(notice).getByRole("link", { name: t("speakRecordLine") }));
    expect(view.location()).toBe("/voices");
    expect(JSON.parse(screen.getByTestId("voices-page").textContent ?? "")).toEqual({
      voice: "Mehdi voice",
      line: "Hello there",
    });
  });
});
