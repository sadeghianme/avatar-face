import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoicesPage } from "@/features/voices";
import type { ClonedVoice, CloneJob } from "@/features/voices/api";
import { translate } from "@/i18n";
import { expectAccessible } from "@/test/axe";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { createServer, type MockServer } from "@/test/server";

// The microphone: what the browser would record, without one.
const mic = vi.hoisted(() => ({ seconds: 8, denied: false }));
vi.mock("@/lib/recorder", () => ({
  MicRecorder: class {
    async start() {
      if (mic.denied) throw new Error("NotAllowedError");
    }
    async stop() {
      return { blob: new Blob(["wav"], { type: "audio/wav" }), url: "blob:test/voice", seconds: mic.seconds };
    }
  },
}));

const t = translate;
const JOBS = `/orgs/${ORG_ID}/clone-jobs`;

const aJob = (extra: Partial<CloneJob> = {}): CloneJob => ({
  id: "j1",
  name: "ana",
  locale: "en-US",
  lines: ["Hello there", "Welcome back"],
  status: "pending",
  error: null,
  done_lines: 0,
  ...extra,
});

function setup(
  {
    jobs = [],
    voices = [],
    renderHere = false,
  }: { jobs?: CloneJob[]; voices?: ClonedVoice[]; renderHere?: boolean } = {},
  prepare?: (server: MockServer) => void
) {
  const server = createServer();
  server
    .on("GET", JOBS, () => jobs)
    .on("GET", `${JOBS}/render-capability`, () => ({ available: renderHere, reason: null }))
    .on("GET", `/orgs/${ORG_ID}/cloned-voices`, () => voices);
  prepare?.(server);
  return renderScreen(<VoicesPage />, { route: "/voices", path: "/voices", server });
}

/** A card on the page, by its heading. */
const card = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

beforeEach(() => {
  mic.seconds = 8;
  mic.denied = false;
});

describe("VoicesPage", () => {
  it("records a voice, then sends it with its name, lines and the speaker's permission", async () => {
    const { user, server } = setup({}, (s) => s.on("POST", JOBS, () => aJob()));
    const send = await screen.findByRole("button", { name: t("voicesSubmit") });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("button", { name: t("voicesRecord") }));
    await user.click(await screen.findByRole("button", { name: t("voicesStop") }));
    expect(await screen.findByText("8.0s")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: t("voicesName") }), "ana");
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: t("voicesConsent") }));
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(server.requests("POST", JOBS)).toHaveLength(1));
    const form = server.requests("POST", JOBS)[0].body as FormData;
    expect(form.get("name")).toBe("ana");
    expect(form.get("consent")).toBe("true");
    expect(JSON.parse(form.get("lines") as string)).toEqual(expect.arrayContaining([expect.any(String)]));
    // Sent: the form is ready for the next voice.
    await waitFor(() => expect(screen.getByRole("textbox", { name: t("voicesName") })).toHaveValue(""));
    expect(screen.getByRole("checkbox", { name: t("voicesConsent") })).not.toBeChecked();
  });

  it("opened from the Speak panel for a line a voice lacks, starts with that voice and that line", async () => {
    const server = createServer();
    server
      .on("GET", JOBS, () => [])
      .on("GET", `${JOBS}/render-capability`, () => ({ available: false, reason: null }))
      .on("GET", `/orgs/${ORG_ID}/cloned-voices`, () => [])
      .on("POST", JOBS, () => aJob());
    const { user } = renderScreen(<VoicesPage />, {
      route: { pathname: "/voices", state: { voice: "Mehdi voice", line: "How can I help you today?" } },
      path: "/voices",
      server,
    });
    expect(await screen.findByRole("textbox", { name: t("voicesName") })).toHaveValue("Mehdi voice");
    expect(screen.getByRole("textbox", { name: new RegExp(t("voicesLines")) })).toHaveValue(
      "How can I help you today?"
    );
    await user.click(screen.getByRole("button", { name: t("voicesRecord") }));
    await user.click(await screen.findByRole("button", { name: t("voicesStop") }));
    await user.click(screen.getByRole("checkbox", { name: t("voicesConsent") }));
    await user.click(screen.getByRole("button", { name: t("voicesSubmit") }));
    await waitFor(() => expect(server.requests("POST", JOBS)).toHaveLength(1));
    const form = server.requests("POST", JOBS)[0].body as FormData;
    expect(form.get("name")).toBe("Mehdi voice");
    expect(JSON.parse(form.get("lines") as string)).toEqual(["How can I help you today?"]);
  });

  it("a recording too short to carry a voice says so and cannot be sent", async () => {
    mic.seconds = 3;
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: t("voicesRecord") }));
    await user.click(await screen.findByRole("button", { name: t("voicesStop") }));
    expect(await screen.findByText(new RegExp(t("voicesTooShort")))).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: t("voicesName") }), "ana");
    await user.click(screen.getByRole("checkbox", { name: t("voicesConsent") }));
    expect(screen.getByRole("button", { name: t("voicesSubmit") })).toBeDisabled();
  });

  it("a refused microphone is said", async () => {
    mic.denied = true;
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: t("voicesRecord") }));
    expect(await screen.findByText(t("voicesMicDenied"))).toBeInTheDocument();
  });

  it("lists the jobs with their state and progress, and the worker's command while one waits", async () => {
    setup({
      jobs: [
        aJob({ id: "j1", name: "waiting" }),
        aJob({ id: "j2", name: "busy", status: "processing", done_lines: 1 }),
        aJob({ id: "j3", name: "broken", status: "failed", error: "GPU out of memory" }),
      ],
    });
    const list = await card(t("voicesJobs"));
    expect(within(list).getByText(t("voicesStatus_pending"))).toBeInTheDocument();
    expect(within(list).getByRole("progressbar", { name: "busy" })).toHaveAttribute("aria-valuenow", "50");
    expect(within(list).getByText("GPU out of memory")).toBeInTheDocument();
    expect(screen.getByText(t("voicesWorkerHint"))).toBeInTheDocument();
    expect(screen.getByText(/scripts\.clone_worker/)).toBeInTheDocument();
  });

  it("renders a waiting job here when this server can", async () => {
    const { user, server } = setup({ jobs: [aJob()], renderHere: true }, (s) =>
      s.on("POST", `${JOBS}/j1/render`, () => ({ ok: true }))
    );
    expect(screen.queryByText(t("voicesWorkerHint"))).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: t("voicesRenderHere") }));
    await waitFor(() => expect(server.requests("POST", `${JOBS}/j1/render`)).toHaveLength(1));
  });

  it("plays a rendered line through the speech path", async () => {
    const { user, server } = setup({ jobs: [aJob({ status: "done", done_lines: 2 })] }, (s) =>
      s.on("POST", `/tts/orgs/${ORG_ID}/synthesize`, () => ({ audio_b64: "AAAA", audio_mime: "audio/wav" }))
    );
    const [play] = await screen.findAllByRole("button", { name: t("speak") });
    await user.click(play);
    await waitFor(() => expect(server.requests("POST", `/tts/orgs/${ORG_ID}/synthesize`)).toHaveLength(1));
    expect(server.requests("POST", `/tts/orgs/${ORG_ID}/synthesize`)[0].body).toEqual({
      provider: "cloned",
      voice: `${ORG_ID}:ana`,
      locale: "en-US",
      text: "Hello there",
    });
  });

  it("lists the voices made, and deletes one", async () => {
    const { user, server } = setup(
      { voices: [{ voice: "org1:ana", label: "ana", locale: "en-US", lines: 12, total_ms: 41_000 }] },
      (s) => s.on("DELETE", `/orgs/${ORG_ID}/cloned-voices/ana`, () => undefined)
    );
    const yours = await card(t("voicesYours"));
    expect(within(yours).getByText(t("voicesStats", { lines: 12, seconds: 41 }))).toBeInTheDocument();
    await user.click(within(yours).getByRole("button", { name: t("delete") }));
    await waitFor(() => expect(server.requests("DELETE", `/orgs/${ORG_ID}/cloned-voices/ana`)).toHaveLength(1));
  });
  it("passes axe, with jobs and voices", async () => {
    const { container } = setup({
      jobs: [aJob(), aJob({ id: "j2", name: "busy", status: "processing", done_lines: 1 })],
      voices: [{ voice: "org1:ana", label: "ana", locale: "en-US", lines: 12, total_ms: 41_000 }],
    });
    await card(t("voicesYours"));
    await expectAccessible(container);
  });
});
