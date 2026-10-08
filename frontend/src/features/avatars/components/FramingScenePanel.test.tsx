/**
 * The Framing & scene panel, as the avatar page shows it: every change
 * previewed at once and saved as a draft once the changes stop; the zoom's
 * presets, the position pad (keys and buttons) and a drag on the preview;
 * the background (a colour, a picture uploaded); an opaque photo told so;
 * a refused save said.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { FramingScenePanel } from "@/features/avatars/components/FramingScenePanel";
import type { SceneDraft } from "@/features/avatars/scene";
import { translate } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { expectAccessible } from "@/test/axe";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = translate;
const AVATAR = `/orgs/${ORG_ID}/avatars/av1`;
const CUT_OUT = { original_image_key: "orgs/org1/avatars/av1/original.png" };

function setup(avatar: Avatar = anAvatar(CUT_OUT), prepare?: (server: MockServer) => void) {
  const server = createServer();
  server
    .on("GET", AVATAR, () => avatar)
    .on("PATCH", AVATAR, (request) => ({ ...avatar, ...(request.body as Partial<Avatar>) }))
    .on("POST", `${AVATAR}/scene-image`, () =>
      anAvatar({
        ...CUT_OUT,
        scene: { zoom: 1, pan: { x: 0, y: 0 }, background: { kind: "image", has_image: true } },
      })
    );
  prepare?.(server);
  const onPreview = vi.fn<(scene: SceneDraft | null) => void>();
  const onRemoveBackground = vi.fn(() => Promise.resolve());
  const surface = createRef<HTMLDivElement>();
  const view = renderScreen(
    <>
      <div ref={surface} data-testid="surface" />
      <FramingScenePanel
        avatar={avatar}
        orgId={ORG_ID}
        surfaceRef={surface}
        onPreview={onPreview}
        onRemoveBackground={onRemoveBackground}
      />
    </>,
    { server }
  );
  return { ...view, onPreview, onRemoveBackground };
}

const patches = (server: MockServer) => server.requests("PATCH", AVATAR);
const lastPreview = (onPreview: ReturnType<typeof setup>["onPreview"]) => onPreview.mock.calls.at(-1)?.[0];

describe("the Framing & scene panel", () => {
  it("a preset previews at once, then saves the scene as a draft and says so", async () => {
    const { server, user, onPreview, container } = setup();
    await user.click(screen.getByRole("button", { name: t("sceneZoomFull") }));
    expect(lastPreview(onPreview)).toMatchObject({ zoom: 0 });
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0].body).toEqual({
      scene: { zoom: 0, pan: { x: 0, y: 0 }, background: { kind: "transparent" } },
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("sceneSaved")));
    expect(screen.getByRole("button", { name: t("sceneZoomFull") })).toHaveAttribute("aria-pressed", "true");
    await expectAccessible(container);
  });

  it("changes in quick succession are saved once, as the last of them", async () => {
    const { server, user } = setup();
    await user.click(screen.getByRole("button", { name: t("scenePanRight") }));
    await user.click(screen.getByRole("button", { name: t("scenePanRight") }));
    await user.click(screen.getByRole("button", { name: t("scenePanDown") }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    const { pan } = (patches(server)[0].body as { scene: SceneDraft }).scene;
    expect(pan.x).toBeGreaterThan(0);
    expect(pan.y).toBeGreaterThan(0);
  });

  it("the position pad moves the picture with the arrow keys, further with Shift", async () => {
    const { user, onPreview } = setup();
    const pad = screen.getByRole("group", { name: t("scenePan") });
    act(() => pad.focus());
    await user.keyboard("{ArrowLeft}");
    const step = -lastPreview(onPreview)!.pan.x;
    expect(step).toBeGreaterThan(0);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(lastPreview(onPreview)!.pan.x).toBeCloseTo(-5 * step);
  });

  it("dragging the preview pans the picture", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frame(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 400));
    const { onPreview } = setup();
    const surface = screen.getByTestId("surface");
    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 240, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(lastPreview(onPreview)!.pan.x).not.toBe(0);
  });

  it("a colour background offers the swatches; one chosen is saved", async () => {
    const { server, user } = setup();
    await user.click(screen.getByRole("radio", { name: t("sceneBgColor") }));
    await user.click(screen.getByRole("button", { name: t("sceneSwatchNavy") }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0].body).toMatchObject({ scene: { background: { kind: "color", color: "#1e3a8a" } } });
  });

  it("a picture background with none yet asks for one, and uploads it", async () => {
    const { server, user } = setup();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const picker = vi.spyOn(input, "click");
    await user.click(screen.getByRole("radio", { name: t("sceneBgImage") }));
    expect(picker).toHaveBeenCalled();
    await user.upload(input, new File(["x"], "beach.png", { type: "image/png" }));
    await waitFor(() => expect(server.requests("POST", `${AVATAR}/scene-image`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(t("sceneSaved")));
  });

  it("a refused save is said", async () => {
    const { user } = setup(anAvatar(CUT_OUT), (server) =>
      server.on("PATCH", AVATAR, () => apiError(422, "not_a_photo", "not a photo"))
    );
    await user.click(screen.getByRole("button", { name: t("sceneZoomFull") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("sceneErrNotPhoto"));
  });

  it("a photo that kept its background is told so, with the removal beside it", async () => {
    const { user, onRemoveBackground } = setup(anAvatar());
    expect(screen.getByText(t("sceneOpaqueHint"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("sceneOpaqueAction") }));
    expect(onRemoveBackground).toHaveBeenCalled();
  });
});
