/**
 * The creation wizard's first two steps (1 Model · 2 Photo), as the
 * member goes through them: the choices, a fresh start, and "Create my
 * avatar" with a description or a photo.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { NewAvatarPage } from "@/features/avatars";
import { creation } from "@/features/avatars/creation/fixtures";
import { FRESH_ENTRY } from "@/features/avatars/wizard";
import i18n from "@/i18n";
import { mockConsent } from "@/test/api";
import { ORG_ID } from "@/test/fixtures";
import { renderScreen, type ScreenOptions } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = i18n.t.bind(i18n);

async function setup(
  {
    route = "/avatars/new",
    agreed = true,
    aiEnabled = true,
  }: { route?: ScreenOptions["route"]; agreed?: boolean; aiEnabled?: boolean } = {},
  prepare?: (server: MockServer) => void
) {
  const server = createServer();
  mockConsent(server, { agreed, aiEnabled });
  server.on("GET", "/stock-avatars", () => []).on("GET", `/orgs/${ORG_ID}/creations`, () => []);
  prepare?.(server);
  const view = renderScreen(<NewAvatarPage />, {
    route,
    path: "/avatars/new",
    server,
    routes: { "/avatars/new/:creationId": <p>Step 3</p>, "/app": <p>The library</p> },
  });
  // The wizard mounts once the organization is known.
  await screen.findByRole("heading", { level: 1 });
  return view;
}

const heading = () => screen.getByRole("heading", { level: 1 });
const radio = (group: HTMLElement, name: string) => within(group).getByRole("radio", { name: new RegExp(name) });

async function toPhotoStep(model: "human" | "animal" = "human", options: Parameters<typeof setup>[0] = {}) {
  const view = await setup(options);
  await view.user.click(screen.getByRole("button", { name: new RegExp(t(`wzModel_${model}`)) }));
  await screen.findByRole("heading", { level: 1, name: t("wzHeading_photo") });
  return view;
}

describe("step 1: the model", () => {
  it("offers a person or an animal, each described, with Cancel back to the library", async () => {
    await setup();
    expect(heading()).toHaveTextContent(t("wzHeading_model"));
    const human = screen.getByRole("button", { name: new RegExp(t("wzModel_human")) });
    expect(human).toHaveAccessibleDescription(t("wzModelHint_human"));
    expect(human).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: new RegExp(t("wzModel_animal")) })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("wzCancel") })).toHaveAttribute("href", "/app");
  });

  it("choosing one goes on to the photo, in the URL, the focus on the new heading", async () => {
    const { location } = await toPhotoStep("animal");
    expect(location()).toBe("/avatars/new?model=animal");
    expect(heading()).toHaveFocus();
    expect(screen.getByText(t("wzIntro_photo_animal"))).toBeInTheDocument();
  });

  it("Back on the photo step returns to the models", async () => {
    const { user, location } = await toPhotoStep();
    await user.click(screen.getByRole("button", { name: t("wzBack") }));
    expect(await screen.findByRole("heading", { level: 1, name: t("wzHeading_model") })).toBeInTheDocument();
    expect(location()).toBe("/avatars/new");
  });

  it("marks the last model chosen, but a fresh start ('New avatar') forgets it", async () => {
    const last = { model: "animal", source: "upload", look: "cartoon", description: "", intent: "ai", statement: null };
    sessionStorage.setItem("liveface.wizard.last", JSON.stringify(last));
    const remembered = await setup();
    expect(screen.getByRole("button", { name: new RegExp(t("wzModel_animal")) })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    remembered.unmount();
    await setup({ route: { pathname: "/avatars/new", state: FRESH_ENTRY } });
    expect(screen.getByRole("button", { name: new RegExp(t("wzModel_animal")) })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(sessionStorage.getItem("liveface.wizard.last")).toBeNull();
  });
});

describe("step 2: the photo", () => {
  it("starts from a description with AI, a realistic look, and the agreements on this screen", async () => {
    await toPhotoStep();
    const source = screen.getByRole("radiogroup", { name: t("wzSourceLabel") });
    expect(radio(source, t("wzSource_generate"))).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: t("wzDescribeLabel_human") })).toBeInTheDocument();
    const look = screen.getByRole("radiogroup", { name: t("wzLookLabel") });
    expect(radio(look, t("wzLook_realistic"))).toHaveAttribute("aria-checked", "true");
    // A remembered AI agreement arrives ticked; the statement about a made-up face is asked.
    expect(screen.getByRole("checkbox", { name: t("wzConsentAi_generate") })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: t("createGeneratedFaceStatement") })).not.toBeChecked();
  });

  it("the look is a radio group: the arrows choose", async () => {
    const { user } = await toPhotoStep();
    const look = screen.getByRole("radiogroup", { name: t("wzLookLabel") });
    await user.click(radio(look, t("wzLook_realistic")));
    await user.keyboard("{ArrowRight}");
    expect(radio(look, t("wzLook_animation"))).toHaveAttribute("aria-checked", "true");
    expect(radio(look, t("wzLook_animation"))).toHaveFocus();
  });

  it("Create waits for a description and the statement, and says what it waits for", async () => {
    const { user } = await toPhotoStep();
    const create = screen.getByRole("button", { name: t("wzCreate") });
    expect(create).toBeDisabled();
    await user.click(screen.getAllByRole("button", { name: t("wzExample_human_1") })[0]);
    expect(screen.getByRole("textbox", { name: t("wzDescribeLabel_human") })).toHaveValue(t("wzExample_human_1"));
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: t("createGeneratedFaceStatement") }));
    expect(create).toBeEnabled();
  });

  it("creates from words: the request, the statement for the new creation, then step 3", async () => {
    const { user, server, location } = await toPhotoStep();
    server
      .on("POST", `/orgs/${ORG_ID}/creations/generate`, () => creation({ id: "c7" }))
      .on("GET", `/orgs/${ORG_ID}/creations/c7`, () => creation({ id: "c7" }));
    await user.type(screen.getByRole("textbox", { name: t("wzDescribeLabel_human") }), "a cheerful baker");
    await user.click(screen.getByRole("radio", { name: new RegExp(t("wzLook_cartoon")) }));
    await user.click(screen.getByRole("checkbox", { name: t("createGeneratedFaceStatement") }));
    await user.click(screen.getByRole("button", { name: t("wzCreate") }));
    expect(await screen.findByText("Step 3")).toBeInTheDocument();
    expect(location()).toBe("/avatars/new/c7");
    expect(server.requests("POST", `/orgs/${ORG_ID}/creations/generate`)[0].body).toEqual({
      model: "human",
      look: "cartoon",
      prompt: "a cheerful baker",
      consent_id: "consent-ai",
    });
    expect(server.requests("POST", `/orgs/${ORG_ID}/consents`)[0].body).toMatchObject({
      scope: "generated_face",
      creation_id: "c7",
    });
  });

  it("a refused creation is said in an alert, and Create can be pressed again", async () => {
    const { user, server } = await toPhotoStep();
    server.on("POST", `/orgs/${ORG_ID}/creations/generate`, () =>
      apiError(429, "image_limit_reached", "limit", {}, { "Retry-After": "60" })
    );
    await user.type(screen.getByRole("textbox", { name: t("wzDescribeLabel_human") }), "a baker");
    await user.click(screen.getByRole("checkbox", { name: t("createGeneratedFaceStatement") }));
    await user.click(screen.getByRole("button", { name: t("wzCreate") }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("createErr_image_limit_reached"));
    expect(screen.getByRole("button", { name: t("wzCreate") })).toBeEnabled();
  });

  it("uploads a photo: its preview, then the creation from the file", async () => {
    const { user, server, location, container } = await toPhotoStep();
    server.on("POST", `/orgs/${ORG_ID}/creations`, () => creation({ id: "c8" }));
    await user.click(screen.getByRole("radio", { name: new RegExp(t("wzSource_upload")) }));
    // A realistic upload may go without the AI: no statement for made-up faces, the person's instead.
    expect(screen.getByRole("checkbox", { name: t("createDepictionStatement") })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(["png"], "maria.png", { type: "image/png" }));
    expect(screen.getByText("maria.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("wzRemovePhoto") })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: t("createDepictionStatement") }));
    await user.click(screen.getByRole("button", { name: t("wzCreate") }));
    expect(await screen.findByText("Step 3")).toBeInTheDocument();
    expect(location()).toBe("/avatars/new/c8");
    const sent = server.requests("POST", `/orgs/${ORG_ID}/creations`)[0].body as FormData;
    expect(sent.get("model")).toBe("human");
    expect(sent.get("look")).toBe("realistic");
    expect((sent.get("file") as File).name).toBe("maria.png");
  });

  it("a file it cannot take is said under the drop zone", async () => {
    const { user, container } = await toPhotoStep();
    await user.click(screen.getByRole("radio", { name: new RegExp(t("wzSource_upload")) }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    // Dropped, not picked: the picker's own filter does not apply.
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["gif"], "cat.gif", { type: "image/gif" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("cat.gif")).not.toBeInTheDocument();
  });

  it("with the organization's AI off: upload only, and the looks that need AI are off", async () => {
    await toPhotoStep("human", { aiEnabled: false });
    const source = screen.getByRole("radiogroup", { name: t("wzSourceLabel") });
    await waitFor(() => expect(radio(source, t("wzSource_upload"))).toHaveAttribute("aria-checked", "true"));
    expect(radio(source, t("wzSource_generate"))).toBeDisabled();
    const look = screen.getByRole("radiogroup", { name: t("wzLookLabel") });
    expect(radio(look, t("wzLook_realistic"))).toBeEnabled();
    expect(radio(look, t("wzLook_cartoon"))).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: t("wzConsentAi_upload") })).not.toBeInTheDocument();
  });

  it("a creation the server refuses for an outdated agreement is agreed again here and sent once more", async () => {
    let calls = 0;
    const { user, server } = await toPhotoStep();
    server
      .on("POST", `/orgs/${ORG_ID}/creations/generate`, () =>
        calls++ === 0 ? apiError(403, "consent_required", "agree", { scope: "third_party_ai" }) : creation({ id: "c9" })
      )
      .on("GET", `/orgs/${ORG_ID}/creations/c9`, () => creation({ id: "c9" }));
    await user.type(screen.getByRole("textbox", { name: t("wzDescribeLabel_human") }), "a baker");
    await user.click(screen.getByRole("checkbox", { name: t("createGeneratedFaceStatement") }));
    await user.click(screen.getByRole("button", { name: t("wzCreate") }));
    expect(await screen.findByText("Step 3")).toBeInTheDocument();
    const sent = server.requests("POST", `/orgs/${ORG_ID}/creations/generate`);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toMatchObject({ consent_id: "consent-third_party_ai" });
  });
});
