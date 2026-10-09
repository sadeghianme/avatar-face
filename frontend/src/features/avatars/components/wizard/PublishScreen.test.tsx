/**
 * The wizard's step 4 (Publish), as the wizard shows it: the points found
 * or to place, the talking preview, the statement about the face, and
 * Publish, which builds the avatar and follows the build to its page.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewAvatarPage } from "@/features/avatars";
import { ai, anchors, creation, job, step } from "@/features/avatars/creation/fixtures";
import type { CreationAnchors } from "@/features/avatars/creation/types";
import { GROUP_LABELS } from "@/features/avatars/face-marks";
import type { Plan, WizardCreation } from "@/features/avatars/wizard";
import { translate } from "@/i18n";
import { mockConsent, mockSpeech } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

vi.mock("@/features/avatars/components/AvatarPreview", () => ({
  AvatarPreview: ({ rigUrl }: { rigUrl: string }) => <div data-testid="talking-preview" data-rig={rigUrl} />,
}));

const t = translate;
const BASE = `/orgs/${ORG_ID}/creations/c1`;
const PLAN: Plan = { model: "human", look: "realistic", source: "upload", description: null };

function ready(extra: Partial<WizardCreation> = {}, anchorExtra: Partial<CreationAnchors> = {}): WizardCreation {
  return {
    ...creation({ statement: null, name: "Maria headshot" }),
    plan: PLAN,
    current: "original",
    steps: [step("original")],
    anchors: anchors(anchorExtra),
    job: job({ step: "prepare", state: "done" }),
    ai: { ...ai(), prepare_rounds_left: 5, free_clears_left: 1, last_prepare: null },
    ...extra,
  };
}

const NOT_FOUND: Partial<CreationAnchors> = {
  detected: false,
  source: "template",
  validation: { ok: true, reasons: [], warnings: [], detected: false, one_click: false },
};
const FOLDED = { code: "folded_mesh", detail: "1 triangle of the face would fold over", count: 1 };
const EYES_CROSSED = { code: "eyes_out_of_order", detail: "The eye corners are out of order" };
const SMOOTHED = { code: "folds_smoothed", detail: "1 thin triangle was smoothed", count: 1 };

/** The head's top point, moved one image pixel right with the arrow key. */
async function nudgeHeadTop(user: ReturnType<typeof renderScreen>["user"]) {
  const handle = screen.getAllByRole("button", { name: new RegExp(`^${t(GROUP_LABELS.head)}: `) })[0];
  act(() => handle.focus());
  await user.keyboard("{ArrowRight}");
}

async function setup(answer: WizardCreation | (() => WizardCreation), prepare?: (server: MockServer) => void) {
  const server = createServer();
  mockConsent(server);
  mockSpeech(server);
  server
    .on("GET", BASE, typeof answer === "function" ? answer : () => answer)
    .on("POST", `${BASE}/preview-rig`, () => ({ rig: { version: 1 }, reasons: [] }));
  prepare?.(server);
  const view = renderScreen(<NewAvatarPage />, {
    route: "/avatars/new/c1?step=publish",
    path: "/avatars/new/:creationId",
    server,
    routes: { "/avatars/:avatarId": <p>The avatar page</p> },
  });
  await screen.findByRole("heading", { level: 1 });
  return view;
}

describe("step 4: Publish", () => {
  it("the face found: its parts listed, the points shown, the name it will have", async () => {
    await setup(ready());
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_publish") })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: t("wzFaceFound") })).toBeInTheDocument();
    const view = screen.getByRole("radiogroup", { name: t("wzViewLabel") });
    expect(within(view).getByRole("radio", { name: t("wzView_points") })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Maria headshot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("wzPublish") })).toBeEnabled();
  });

  it("fits the preview without saving, and shows it talking on the preview view", async () => {
    const { user, server } = await setup(ready());
    await waitFor(() => expect(server.requests("POST", `${BASE}/preview-rig`)).toHaveLength(1));
    expect(server.requests("POST", `${BASE}/preview-rig`)[0].body).toEqual({ anchors_id: "a1" });
    await user.click(screen.getByRole("radio", { name: t("wzView_preview") }));
    expect(await screen.findByTestId("talking-preview")).toBeVisible();
  });

  it("Publish builds it on the face found, follows the build, and opens the avatar's page", async () => {
    let state = ready();
    const { user, server, location } = await setup(
      () => state,
      (s) =>
        s.on("POST", `${BASE}/finish`, () => {
          state = ready({
            status: "finishing",
            job: job({ step: "finish", state: "running", progress: { fraction: 0.2, label: "building the rig" } }),
          });
          return { avatar_id: "av9", creation: state, warnings: [] };
        })
    );
    await user.click(screen.getByRole("button", { name: t("wzPublish") }));
    await waitFor(() => expect(server.requests("POST", `${BASE}/finish`)).toHaveLength(1));
    // One click on a face it found: the server keeps its own points.
    expect(server.requests("POST", `${BASE}/finish`)[0].body).toEqual({ name: "Maria headshot", anchors_id: "a1" });
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_publishing") })).toBeInTheDocument();
    state = ready({ status: "finished", avatar_id: "av9", job: job({ step: "finish", state: "done" }) });
    expect(await screen.findByText("The avatar page", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(location()).toBe("/avatars/av9");
  });

  it("points that would stretch the face are listed, and Publish waits", async () => {
    const { user } = await setup(ready(), (s) =>
      s.on("POST", `${BASE}/finish`, () =>
        apiError(422, "fit_invalid", "bad fit", { reasons: [{ code: "eyes_crossed", detail: "The eyes cross" }] })
      )
    );
    await user.click(screen.getByRole("button", { name: t("wzPublish") }));
    const problems = await screen.findByText(t("wzFitProblems"));
    expect(problems.closest("[role=alert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: t("wzPublish") })).toBeDisabled();
  });

  it("a face found whose points the fit refuses says it was found, lists why, and says what to do", async () => {
    await setup(ready(), (s) =>
      s.on("POST", `${BASE}/preview-rig`, () => ({ rig: { version: 1 }, reasons: [FOLDED], notes: [] }))
    );
    expect(await screen.findByText(t("wzFoundCheck"))).toBeInTheDocument();
    expect(screen.queryByText(t("wzNotFound"))).not.toBeInTheDocument();
    expect(await screen.findByText(t("fitFolded", { count: 1 }))).toBeInTheDocument();
    // Found points need no tick: the refusal is what holds Publish.
    expect(screen.queryByRole("checkbox", { name: t("wzPointsConfirm") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("wzPublish") })).toBeDisabled();
    expect(screen.getAllByText(t("wzHoldFitMove")).length).toBeGreaterThan(0);
    // Nothing was moved, so there is nothing to put back.
    expect(screen.queryByRole("button", { name: t("wzFixPoints") })).not.toBeInTheDocument();
  });

  it("points refused when they were found, passing now: the newest preview has the last word", async () => {
    const stale: Partial<CreationAnchors> = {
      validation: { ok: false, reasons: [FOLDED], warnings: [], detected: true, one_click: false },
    };
    const { server } = await setup(ready({}, stale));
    await waitFor(() => expect(server.requests("POST", `${BASE}/preview-rig`)).toHaveLength(1));
    expect(await screen.findByRole("list", { name: t("wzFaceFound") })).toBeInTheDocument();
    expect(screen.queryByText(t("wzNotFound"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("wzFitProblems"))).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: t("wzPointsConfirm") })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: t("wzPublish") })).toBeEnabled());
  });

  it("moved points the fit refuses: “Fix it for me” puts them back where found, and Publish follows", async () => {
    const { user, server } = await setup(ready(), (s) =>
      s.on("POST", `${BASE}/preview-rig`, (request) =>
        (request.body as { marks?: unknown }).marks
          ? { rig: { version: 1 }, reasons: [EYES_CROSSED], notes: [] }
          : { rig: { version: 1 }, reasons: [], notes: [] }
      )
    );
    await waitFor(() => expect(server.requests("POST", `${BASE}/preview-rig`)).toHaveLength(1));
    await nudgeHeadTop(user);
    const fix = await screen.findByRole("button", { name: t("wzFixPoints") }, { timeout: 3000 });
    expect(screen.getByRole("button", { name: t("wzPublish") })).toBeDisabled();
    expect(screen.getAllByText(t("wzHoldFit")).length).toBeGreaterThan(0);
    await user.click(fix);
    await waitFor(() => expect(screen.getByRole("button", { name: t("wzPublish") })).toBeEnabled(), {
      timeout: 3000,
    });
    const previews = server.requests("POST", `${BASE}/preview-rig`);
    expect(previews.at(-1)?.body).toEqual({ anchors_id: "a1" });
    expect(screen.queryByText(t("wzFitProblems"))).not.toBeInTheDocument();
  });

  it("Reset points puts back a layout that publishes", async () => {
    const { user, server } = await setup(ready(), (s) =>
      s.on("POST", `${BASE}/preview-rig`, (request) =>
        (request.body as { marks?: unknown }).marks
          ? { rig: { version: 1 }, reasons: [FOLDED], notes: [] }
          : { rig: { version: 1 }, reasons: [], notes: [] }
      )
    );
    await waitFor(() => expect(server.requests("POST", `${BASE}/preview-rig`)).toHaveLength(1));
    const reset = screen.getByRole("button", { name: t("wzResetPoints") });
    expect(reset).toBeDisabled();
    await nudgeHeadTop(user);
    await screen.findByText(t("fitFolded", { count: 1 }), {}, { timeout: 3000 });
    expect(reset).toBeEnabled();
    await user.click(reset);
    await waitFor(() => expect(screen.getByRole("button", { name: t("wzPublish") })).toBeEnabled(), {
      timeout: 3000,
    });
    expect(server.requests("POST", `${BASE}/preview-rig`).at(-1)?.body).toEqual({ anchors_id: "a1" });
  });

  it("a crease the fit smoothed between two points is said in a line, and holds nothing", async () => {
    await setup(ready(), (s) =>
      s.on("POST", `${BASE}/preview-rig`, () => ({ rig: { version: 1 }, reasons: [], notes: [SMOOTHED] }))
    );
    expect(await screen.findByText(t("wzFitSmoothed"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("wzPublish") })).toBeEnabled();
  });

  it("a face not found: place the points, then say they are right before Publish", async () => {
    const { user } = await setup(ready({}, NOT_FOUND));
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_fix") })).toBeInTheDocument();
    expect(screen.getByText(t("wzNotFound"))).toBeInTheDocument();
    const publish = screen.getByRole("button", { name: t("wzPublish") });
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: t("wzPointsConfirm") }));
    expect(publish).toBeEnabled();
  });

  it("a statement the server asks for is a box to tick here, recorded before the build", async () => {
    const { user, server } = await setup(ready({ statement: "depiction" }), (s) =>
      s.on("POST", `${BASE}/finish`, () => ({
        avatar_id: "av9",
        creation: ready({ status: "finishing", job: job({ step: "finish", state: "running" }) }),
        warnings: [],
      }))
    );
    const publish = await screen.findByRole("button", { name: t("wzPublish") });
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: t("createDepictionStatement") }));
    await user.click(publish);
    await waitFor(() => expect(server.requests("POST", `${BASE}/finish`)).toHaveLength(1));
    expect(server.requests("POST", `/orgs/${ORG_ID}/consents`)[0].body).toMatchObject({
      scope: "depiction",
      creation_id: "c1",
    });
    expect(server.requests("POST", `${BASE}/finish`)[0].body).toMatchObject({ consent_id: "consent-depiction" });
  });

  it("Back returns to Prepare", async () => {
    const { user, location } = await setup(ready());
    await user.click(await screen.findByRole("button", { name: t("wzBack") }));
    await waitFor(() => expect(location()).toBe("/avatars/new/c1"));
  });
  it("passes axe, a face to place with a statement to make", async () => {
    const { container } = await setup(ready({ statement: "depiction" }, NOT_FOUND));
    await screen.findByRole("checkbox", { name: t("wzPointsConfirm") });
    await expectAccessible(container);
  });
});
