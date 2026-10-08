/**
 * Marking the face by hand, on the avatar page: the detected marks to
 * start from, Test (the rig they would make, fitted and not saved, then
 * again after each move), what the server would refuse, Save and Re-detect
 * (each closes the panel), and Reset back to the detected marks.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MarkFacePanel } from "@/features/avatars/components/MarkFacePanel";
import { marks } from "@/features/avatars/creation/fixtures";
import { type FaceMarks, GROUP_LABELS } from "@/features/avatars/face-marks";
import { translate } from "@/i18n";
import { mockSpeech } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

vi.mock("@/features/avatars/components/AvatarPreview", () => ({
  AvatarPreview: ({ rigUrl }: { rigUrl: string }) => <div data-testid="fitted-preview" data-rig={rigUrl} />,
}));

const t = translate;
const BASE = `/orgs/${ORG_ID}/avatars/av1`;
const FOLDED = { code: "folded_mesh", detail: "folded", count: 2 };

function setup(prepare?: (server: MockServer) => void) {
  const server = createServer();
  mockSpeech(server);
  server
    .on("GET", `${BASE}/rig-anchors`, () => ({ anchors: marks(), image_size: [1000, 1000] }))
    .on("GET", BASE, () => anAvatar())
    .on("POST", `${BASE}/rig-fit`, () => ({ rig: { version: 1 }, reasons: [] }))
    .on("POST", `${BASE}/rig-reset`, () => anAvatar());
  prepare?.(server);
  const onClose = vi.fn();
  const view = renderScreen(<MarkFacePanel avatar={anAvatar()} orgId={ORG_ID} onClose={onClose} />, { server });
  return { ...view, onClose };
}

const fits = (server: MockServer) => server.requests("POST", `${BASE}/rig-fit`);
const sent = (server: MockServer, n: number) => fits(server)[n].body as FaceMarks & { persist: boolean };

/** The head's top point, moved one image pixel right with the arrow key. */
async function nudgeHeadTop(user: ReturnType<typeof setup>["user"]) {
  const handle = screen.getAllByRole("button", { name: new RegExp(`^${t(GROUP_LABELS.head)}: `) })[0];
  act(() => handle.focus());
  await user.keyboard("{ArrowRight}");
}

describe("marking the face", () => {
  it("opens on the detected marks; Test previews the rig they would make, not saved", async () => {
    const { server, user, container } = setup();
    expect(await screen.findByRole("heading", { name: t("markFace") })).toBeInTheDocument();
    expect(screen.getByText(t("testHint"))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("test") }));
    const preview = await screen.findByTestId("fitted-preview");
    expect(preview.dataset.rig).toMatch(/^blob:/);
    expect(sent(server, 0)).toMatchObject({ persist: false });
    await expectAccessible(container);
  });

  it("once tested, a moved point is fitted again", async () => {
    const { server, user } = setup();
    await user.click(await screen.findByRole("button", { name: t("test") }));
    await screen.findByTestId("fitted-preview");
    await nudgeHeadTop(user);
    await waitFor(() => expect(fits(server)).toHaveLength(2), { timeout: 2000 });
    expect(sent(server, 1).head.top.x).toBe(marks().head.top.x + 1);
  });

  it("what the server would refuse is listed; moving a point clears it", async () => {
    const { user } = setup((server) =>
      server.on("POST", `${BASE}/rig-fit`, () => ({ rig: { version: 1 }, reasons: [FOLDED] }))
    );
    await user.click(await screen.findByRole("button", { name: t("test") }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("fitRefusedTitle"));
    expect(alert).toHaveTextContent(t("fitFolded", { count: 2 }));
    await nudgeHeadTop(user);
    await waitFor(() => expect(screen.queryByText(t("fitRefusedTitle"))).not.toBeInTheDocument());
  });

  it("Save fits and keeps the marks, then closes", async () => {
    const { server, user, onClose } = setup();
    await user.click(await screen.findByRole("button", { name: t("save") }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent(server, 0)).toMatchObject({ persist: true });
  });

  it("a refused Save lists why and stays open", async () => {
    const { user, onClose } = setup((server) =>
      server.on("POST", `${BASE}/rig-fit`, () => apiError(422, "fit_invalid", "invalid", { reasons: [FOLDED] }))
    );
    await user.click(await screen.findByRole("button", { name: t("save") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("fitFolded", { count: 2 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("save") })).toBeEnabled();
  });

  it("Re-detect throws the marking away and closes; a refusal is said", async () => {
    const first = setup();
    await first.user.click(await screen.findByRole("button", { name: t("redetect") }));
    await waitFor(() => expect(first.onClose).toHaveBeenCalled());
    expect(first.server.requests("POST", `${BASE}/rig-reset`)).toHaveLength(1);
    first.unmount();

    const second = setup((server) =>
      server.on("POST", `${BASE}/rig-reset`, () => apiError(409, "no_original", "No original photo"))
    );
    await second.user.click(await screen.findByRole("button", { name: t("redetect") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No original photo");
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it("Reset puts the points back where they were detected", async () => {
    const { server, user } = setup();
    await user.click(await screen.findByRole("button", { name: t("test") }));
    await screen.findByTestId("fitted-preview");
    await nudgeHeadTop(user);
    await waitFor(() => expect(fits(server)).toHaveLength(2), { timeout: 2000 });
    await user.click(screen.getByRole("button", { name: t("resetDetected") }));
    await waitFor(() => expect(fits(server)).toHaveLength(3), { timeout: 2000 });
    expect(sent(server, 2).head.top).toEqual(marks().head.top);
  });
});
