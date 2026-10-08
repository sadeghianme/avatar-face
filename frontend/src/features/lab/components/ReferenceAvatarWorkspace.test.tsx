/**
 * The reference lab's bench, with the previews and the photographic
 * mouth's loader stood in for: the poses (once both previews run), the
 * candidate (photographic or the previous prototype), the close-up, the
 * performance that cannot load, the member's own avatar (a mouth photo to
 * add, its quality note), and a voice the lab cannot time.
 */
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReferenceAvatarWorkspace } from "@/features/lab/components/ReferenceAvatarWorkspace";
import { REFERENCE_AVATAR } from "@/features/lab/reference-avatar";
import { translate } from "@/i18n";
import { mockSpeech } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { createServer } from "@/test/server";

const lab = vi.hoisted(() => ({
  /** What the next performance load does: a mouth, or fail with this name. */
  failWith: null as string | null,
  loads: [] as unknown[],
}));

vi.mock("@/features/lab/components/LipSyncPreview", async () => {
  const { useEffect } = await import("react");
  return {
    LipSyncPreview: ({
      onEngine,
      mouthOnly,
      pose,
      mouthExtension,
    }: {
      onEngine: (engine: unknown) => void;
      mouthOnly?: boolean;
      pose?: () => unknown;
      mouthExtension?: { kind?: string };
    }) => {
      useEffect(() => {
        onEngine({ tuning: {} });
        return () => onEngine(null);
      }, [onEngine]);
      return (
        <div
          data-testid="preview"
          data-mouth-only={String(Boolean(mouthOnly))}
          data-posed={String(Boolean(pose?.()))}
          data-mouth={mouthExtension?.kind ?? "classic"}
        />
      );
    },
  };
});
vi.mock("@liveface/embed/mouth/continuous-mouth", () => ({
  ContinuousMouth: {
    load: (_url: string, teeth: unknown) => {
      lab.loads.push(teeth);
      if (!lab.failWith) return Promise.resolve({ kind: "photographic", setProfile() {} });
      const error = new Error("no");
      error.name = lab.failWith;
      return Promise.reject(error);
    },
  },
}));
vi.mock("@liveface/embed/mouth/reference-mouth", () => ({
  ReferenceMouth: class {
    kind = "geometry";
    setProfile() {}
  },
}));

const t = translate;

function setup(avatar = REFERENCE_AVATAR) {
  const server = createServer();
  mockSpeech(server);
  return renderScreen(<ReferenceAvatarWorkspace avatar={avatar} orgId={ORG_ID} />, { server });
}

const previews = () => screen.getAllByTestId("preview");

describe("the reference lab's bench", () => {
  beforeEach(() => {
    lab.failWith = null;
    lab.loads = [];
  });

  it("compares the current mouth with the photographic one, posed at rest", async () => {
    const view = setup();
    await waitFor(() => expect(previews()).toHaveLength(2));
    expect(previews()[1].dataset.mouth).toBe("photographic");
    expect(lab.loads).toEqual(["reference"]);
    expect(previews().every((p) => p.dataset.posed === "true")).toBe(true);
    expect(screen.getByRole("button", { name: t("referenceRest") })).toHaveAttribute("aria-pressed", "true");
    await expectAccessible(view.container);
  });

  it("a pose is held in both once both run; the close-up and the previous prototype on demand", async () => {
    const { user } = setup();
    const aa = screen.getByRole("button", { name: t("referenceAA") });
    await waitFor(() => expect(aa).toBeEnabled());
    await user.click(aa);
    expect(aa).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: t("referenceRest") })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: t("referenceMouthView") }));
    expect(previews().every((p) => p.dataset.mouthOnly === "true")).toBe(true);

    await user.click(screen.getByRole("button", { name: t("referenceGeometry") }));
    expect(screen.getByRole("heading", { name: t("referenceCandidate") })).toBeInTheDocument();
    expect(previews()[1].dataset.mouth).toBe("geometry");
    // Changing the candidate goes back to rest.
    expect(screen.getByRole("button", { name: t("referenceRest") })).toHaveAttribute("aria-pressed", "true");
  });

  it("a performance that cannot load says why", async () => {
    lab.failWith = "DentalPhotoError";
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(t("referenceTeethPhotoError"));
  });

  it("the member's own avatar: its quality note, a mouth photo to add, the fitted mouth meanwhile", async () => {
    setup(anAvatar({ quality_note: "The mouth may be off." }));
    expect(await screen.findByText("The mouth may be off.")).toBeInTheDocument();
    expect(screen.getByText(t("referenceFittedMouthActive"))).toBeInTheDocument();
    expect(screen.getByText(t("referenceMouthUploadTitle"))).toBeInTheDocument();
    await waitFor(() => expect(lab.loads).toEqual([undefined]));
  });

  it("a voice the lab cannot time is said, and nothing can be generated with it", async () => {
    const server = createServer();
    mockSpeech(server);
    server.on("GET", "/tts/providers", () => [
      { name: "kokoro", display_name: "Kokoro" },
      { name: "browser", display_name: "Browser voice" },
    ]);
    const { user } = renderScreen(<ReferenceAvatarWorkspace avatar={REFERENCE_AVATAR} orgId={ORG_ID} />, { server });
    const generate = screen.getByRole("button", { name: t("lipSyncGenerate") });
    await waitFor(() => expect(generate).toBeEnabled());
    expect(screen.queryByText(t("lipSyncServerOnly"))).not.toBeInTheDocument();
    const provider = screen.getByRole("combobox", { name: t("provider") });
    await screen.findByRole("option", { name: "Browser voice" });
    await user.selectOptions(provider, "browser");
    expect(await screen.findByText(t("lipSyncServerOnly"))).toBeInTheDocument();
    expect(generate).toBeDisabled();
  });
});
