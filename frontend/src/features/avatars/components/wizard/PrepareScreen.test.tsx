/**
 * The wizard's step 3 (Prepare), as the wizard shows it: it starts by
 * itself, says why it failed and what to do next, asks for the AI
 * agreement when it needs one, and goes on once a picture is ready.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NewAvatarPage } from "@/features/avatars";
import { ai, anchors, creation, job, step } from "@/features/avatars/creation/fixtures";
import type { Plan, WizardCreation } from "@/features/avatars/wizard";
import { translate } from "@/i18n";
import { mockConsent } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = translate;
const BASE = `/orgs/${ORG_ID}/creations/c1`;

const UPLOAD: Plan = { model: "human", look: "realistic", source: "upload", description: null };
const GENERATE: Plan = { model: "human", look: "animation", source: "generate", description: "a baker" };

function draft(plan: Plan, extra: Partial<WizardCreation> = {}): WizardCreation {
  return {
    ...creation({ statement: null }),
    plan,
    ai: { ...ai(), prepare_rounds_left: 6, free_clears_left: 1, last_prepare: null },
    ...extra,
  };
}

const failed = (code: string, retryable: boolean) =>
  job({ step: "prepare", state: "failed", error: { code, detail: code }, retryable });
const running = () =>
  job({ step: "prepare", state: "running", progress: { fraction: 0.4, label: "creating your avatar" } });

/** A picture made and its face found: step 3 is done. */
function prepared(plan: Plan = UPLOAD): WizardCreation {
  return draft(plan, {
    current: "original",
    steps: [step("original")],
    anchors: anchors(),
    job: job({ step: "prepare", state: "done" }),
    ai: {
      ...ai(),
      prepare_rounds_left: 5,
      free_clears_left: 1,
      last_prepare: { mode: "ai", look: plan.look, instruction: null, step: "original", cut: true },
    },
  });
}

async function setup(
  answer: WizardCreation | (() => WizardCreation),
  { agreed = true, prepare }: { agreed?: boolean; prepare?: (server: MockServer) => void } = {}
) {
  const server = createServer();
  mockConsent(server, { agreed });
  server.on("GET", BASE, typeof answer === "function" ? answer : () => answer);
  prepare?.(server);
  const view = renderScreen(<NewAvatarPage />, {
    route: "/avatars/new/c1",
    path: "/avatars/new/:creationId",
    server,
    routes: { "/avatars/new": <p>Step 2</p> },
  });
  await screen.findByRole("heading", { level: 1 });
  return view;
}

describe("step 3: Prepare", () => {
  it("a failure says why, with Try again, the photo as it is, and another photo", async () => {
    await setup(draft(UPLOAD, { job: failed("provider_error", true) }));
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_prepareFailed") })).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(t("createErr_provider_error"));
    expect(within(alert).getByRole("button", { name: t("wzTryAgain") })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: t("wzUseOriginal") })).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: t("wzOtherPhoto") })).toBeInTheDocument();
  });

  it("Try again runs the failed job again with the remembered agreement, and shows it working", async () => {
    let state: WizardCreation = draft(UPLOAD, { job: failed("provider_error", true) });
    const { user, server } = await setup(() => state, {
      prepare: (s) =>
        s.on("POST", `${BASE}/retry`, () => {
          state = draft(UPLOAD, { job: running() });
          return state;
        }),
    });
    await user.click(await screen.findByRole("button", { name: t("wzTryAgain") }));
    await waitFor(() => expect(server.requests("POST", `${BASE}/retry`)).toHaveLength(1));
    expect(server.requests("POST", `${BASE}/retry`)[0].body).toEqual({ consent_id: "consent-ai" });
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_prepare") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a failure that cannot be retried offers no Try again", async () => {
    await setup(draft(UPLOAD, { job: failed("no_face", false) }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).queryByRole("button", { name: t("wzTryAgain") })).not.toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: t("wzUseOriginal") })).toBeInTheDocument();
  });

  it("'Use my original photo' prepares the photo as it is, without the AI", async () => {
    const { user, server } = await setup(draft(UPLOAD, { job: failed("safety_refused", true) }), {
      prepare: (s) => s.on("POST", `${BASE}/prepare`, () => draft(UPLOAD, { job: running() })),
    });
    await user.click(await screen.findByRole("button", { name: t("wzUseOriginal") }));
    await waitFor(() => expect(server.requests("POST", `${BASE}/prepare`)).toHaveLength(1));
    expect(server.requests("POST", `${BASE}/prepare`)[0].body).toMatchObject({ mode: "original" });
  });

  it("another photo: the draft is deleted and step 2 comes back", async () => {
    const { user, server, location } = await setup(draft(UPLOAD, { job: failed("no_face", false) }), {
      prepare: (s) => s.on("DELETE", BASE, () => undefined),
    });
    await user.click(await screen.findByRole("button", { name: t("wzOtherPhoto") }));
    expect(await screen.findByText("Step 2")).toBeInTheDocument();
    expect(location()).toBe("/avatars/new?model=human");
    expect(server.requests("DELETE", BASE)).toHaveLength(1);
  });

  it("starts by itself with the AI when the member agreed before", async () => {
    const { server } = await setup(draft(UPLOAD, { job: job({ step: "ingest", state: "done" }) }), {
      prepare: (s) => s.on("POST", `${BASE}/prepare`, () => draft(UPLOAD, { job: running() })),
    });
    await waitFor(() => expect(server.requests("POST", `${BASE}/prepare`)).toHaveLength(1));
    expect(server.requests("POST", `${BASE}/prepare`)[0].body).toEqual({ mode: "ai", consent_id: "consent-ai" });
  });

  it("a character without the member's agreement waits for it: ticked, then Use AI", async () => {
    const { user, server } = await setup(draft(GENERATE, { job: job({ step: "ingest", state: "done" }) }), {
      agreed: false,
      prepare: (s) => s.on("POST", `${BASE}/prepare`, () => draft(GENERATE, { job: running() })),
    });
    expect(await screen.findByText(t("wzAiNeeded"))).toBeInTheDocument();
    const useAi = screen.getByRole("button", { name: t("wzUseAi") });
    expect(useAi).toBeDisabled();
    // No photo of its own to fall back on.
    expect(screen.queryByRole("button", { name: t("wzUseOriginal") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: t("wzConsentAi_generate") }));
    await user.click(useAi);
    await waitFor(() => expect(server.requests("POST", `${BASE}/prepare`)).toHaveLength(1));
    expect(server.requests("POST", `/orgs/${ORG_ID}/consents`)[0].body).toMatchObject({ scope: "third_party_ai" });
    expect(server.requests("POST", `${BASE}/prepare`)[0].body).toEqual({
      mode: "ai",
      consent_id: "consent-third_party_ai",
    });
  });

  it("a refused prepare is said with its next action", async () => {
    const { user } = await setup(draft(UPLOAD, { job: failed("provider_error", true) }), {
      prepare: (s) =>
        s.on("POST", `${BASE}/retry`, () => apiError(429, "too_many_jobs", "busy", {}, { "Retry-After": "20" })),
    });
    await user.click(await screen.findByRole("button", { name: t("wzTryAgain") }));
    expect(await screen.findByText(new RegExp(t("createErr_too_many_jobs").slice(0, 20)))).toBeInTheDocument();
  });

  it("a picture ready: the change box, the tries left, and Continue to Publish", async () => {
    const { user, location } = await setup(prepared());
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_prepared") })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: t("wzChangeLabel") })).toBeInTheDocument();
    expect(screen.getByText(t("wzTriesLeft", { count: 5 }))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: new RegExp(t("wzContinue")) }));
    expect(location()).toBe("/avatars/new/c1?step=publish");
  });

  it("describes a change in words and sends it", async () => {
    const { user, server } = await setup(prepared(), {
      prepare: (s) => s.on("POST", `${BASE}/prepare`, () => prepared()),
    });
    const box = await screen.findByRole("textbox", { name: t("wzChangeLabel") });
    const apply = screen.getByRole("button", { name: t("wzApply") });
    expect(apply).toBeDisabled();
    await user.type(box, "shorter hair");
    await user.click(apply);
    await waitFor(() => expect(server.requests("POST", `${BASE}/prepare`)).toHaveLength(1));
    expect(server.requests("POST", `${BASE}/prepare`)[0].body).toMatchObject({
      mode: "change",
      instruction: "shorter hair",
    });
    await waitFor(() => expect(box).toHaveValue(""));
  });
  it("passes axe, failed and prepared", async () => {
    const failedView = await setup(draft(UPLOAD, { job: failed("provider_error", true) }));
    await screen.findByRole("alert");
    await expectAccessible(failedView.container);
    failedView.unmount();
    const { container } = await setup(prepared());
    await screen.findByRole("textbox", { name: t("wzChangeLabel") });
    await expectAccessible(container);
  });
});
