import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExpressionsPanel } from "@/features/avatars/components/ExpressionsPanel";
import type { ExpressionsView } from "@/features/avatars/expressions";
import { translate } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { mockConsent } from "@/test/api";
import { expectAccessible } from "@/test/axe";
import { anAvatar, ORG_ID } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { apiError, createServer, type MockServer } from "@/test/server";

const t = translate;
const AVATAR = `/orgs/${ORG_ID}/avatars/av1`;
const EXPR = `${AVATAR}/expressions`;

const off = (extra: Partial<ExpressionsView> = {}): ExpressionsView => ({
  ai: false,
  delivery: "now",
  kit: null,
  pending: false,
  manifest_url: null,
  picture_urls: {},
  job: null,
  ...extra,
});

const madeKit = (): NonNullable<ExpressionsView["kit"]> => ({
  id: "k1",
  made_at: "2026-10-11T10:00:00Z",
  source: "panel",
  model: "gemini",
  made: 4,
  calls: 5,
  shots: {
    happy: { status: "ok", outcome: "generated", reason: null, smile: true },
    surprised: { status: "ok", outcome: "generated", reason: null, smile: false },
    concerned: { status: "ok", outcome: "generated", reason: null, smile: false },
    thinking: {
      status: "failed",
      outcome: "rejected",
      reason: { code: "expression_not_reached", detail: "Not thinking" },
      smile: false,
    },
    serious: { status: "ok", outcome: "generated", reason: null, smile: false },
  },
});

const made = (): ExpressionsView =>
  off({
    ai: true,
    kit: madeKit(),
    manifest_url: "https://cdn/m.json",
    picture_urls: {
      happy: "https://cdn/h.webp",
      surprised: "https://cdn/s.webp",
      concerned: "https://cdn/c.webp",
      serious: "https://cdn/x.webp",
    },
  });

function setup(
  first: ExpressionsView,
  prepare?: (server: MockServer) => void,
  {
    aiEnabled = true,
    agreed = true,
    avatar = anAvatar(),
  }: { aiEnabled?: boolean; agreed?: boolean; avatar?: Avatar } = {}
) {
  const server = createServer();
  mockConsent(server, { aiEnabled, agreed });
  server.on("GET", EXPR, () => first).on("GET", AVATAR, () => avatar);
  prepare?.(server);
  return { ...renderScreen(<ExpressionsPanel avatar={avatar} orgId={ORG_ID} />, { server }), server };
}

describe("ExpressionsPanel", () => {
  it("off: says what AI pictures are, with the switch off and Make offered", async () => {
    const { container } = setup(off());
    const toggle = await screen.findByRole("switch", { name: t("exprUse") });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(t("exprIntro"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("exprMake") })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await expectAccessible(container);
  });

  it("turning it on asks the consent, then saves the choice with it", async () => {
    const { user, server } = setup(off(), (s) => s.on("PUT", EXPR, () => off({ ai: true })), { agreed: false });
    await user.click(await screen.findByRole("switch", { name: t("exprUse") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: new RegExp(t("aiConsentAgree")) }));
    await waitFor(() => expect(server.requests("PUT", EXPR)).toHaveLength(1));
    expect(server.requests("PUT", EXPR)[0].body).toEqual({
      ai: true,
      consent_id: "consent-third_party_ai",
      delivery: null,
    });
    expect(await screen.findByRole("radiogroup", { name: t("exprDelivery") })).toBeInTheDocument();
  });

  it("on: the delivery is chosen, and turning it off sends no consent", async () => {
    const { user, server } = setup(off({ ai: true }), (s) =>
      s.on("PUT", EXPR, (request) => {
        const body = request.body as { ai: boolean; delivery: string | null };
        return off({ ai: body.ai, delivery: (body.delivery ?? "now") as "now" | "batch" });
      })
    );
    await user.click(await screen.findByRole("radio", { name: t("exprDeliveryBatch") }));
    await waitFor(() => expect(server.requests("PUT", EXPR)).toHaveLength(1));
    expect(server.requests("PUT", EXPR)[0].body).toEqual({
      ai: true,
      consent_id: "consent-ai",
      delivery: "batch",
    });
    await user.click(screen.getByRole("switch", { name: t("exprUse") }));
    await waitFor(() => expect(server.requests("PUT", EXPR)).toHaveLength(2));
    expect(server.requests("PUT", EXPR)[1].body).toEqual({ ai: false, consent_id: null, delivery: null });
  });

  it("shows the five: four pictures, and why the fifth stays animated", async () => {
    const { container } = setup(made());
    expect(await screen.findByText(t("exprMade", { made: 4, total: 5 }))).toBeInTheDocument();
    const grid = screen.getByRole("list", { name: t("exprShotsLabel") });
    expect(within(grid).getAllByRole("img")).toHaveLength(4);
    expect(within(grid).getByText(t("exprReason_notReached"))).toBeInTheDocument();
    expect(within(grid).getByText(t("exprSmile"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("exprMakeAgain") })).toBeInTheDocument();
    await expectAccessible(container);
  });

  it("Make sends the consent and follows the job, counted, to its end", async () => {
    const running = {
      id: "j1",
      step: "expression_kit" as const,
      state: "running" as const,
      error: null,
      started_at: "2026-10-11T10:00:00Z",
      progress: { fraction: 0.4, label: "making the expressions", count: { done: 2, total: 5 } },
      retryable: false,
    };
    let polls = 0;
    const { user, server } = setup(off(), (s) =>
      s
        .on("POST", `${EXPR}/make`, () => off({ ai: true, job: running }))
        .on("GET", EXPR, () => {
          polls += 1;
          return polls < 2 ? off() : made();
        })
    );
    await user.click(await screen.findByRole("button", { name: t("exprMake") }));
    await waitFor(() => expect(server.requests("POST", `${EXPR}/make`)).toHaveLength(1));
    expect(server.requests("POST", `${EXPR}/make`)[0].body).toEqual({ consent_id: "consent-ai" });
    expect(await screen.findByText(t("exprStage_making"))).toBeInTheDocument();
    expect(screen.getByText(t("exprCount", { done: 2, total: 5 }))).toBeInTheDocument();
    expect(await screen.findByText(t("exprMade", { made: 4, total: 5 }), {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("a refusal is said in the panel's words", async () => {
    const { user } = setup(off(), (s) =>
      s.on("POST", `${EXPR}/make`, () => apiError(429, "image_limit_reached", "limit"))
    );
    await user.click(await screen.findByRole("button", { name: t("exprMake") }));
    expect(await screen.findByText(t("exprErr_limit"))).toBeInTheDocument();
  });

  it("a batch on its way is said", async () => {
    setup(off({ ai: true, delivery: "batch", pending: true }));
    expect(await screen.findByText(t("exprPending"))).toBeInTheDocument();
  });

  it("Remove asks once, then takes them out", async () => {
    const { user, server } = setup(made(), (s) => s.on("DELETE", EXPR, () => off()));
    await user.click(await screen.findByRole("button", { name: t("exprRemove") }));
    await user.click(screen.getByRole("button", { name: t("exprRemoveConfirm") }));
    await waitFor(() => expect(server.requests("DELETE", EXPR)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("list", { name: t("exprShotsLabel") })).not.toBeInTheDocument());
  });

  it("with third-party AI off, only says so", async () => {
    setup(off(), undefined, { aiEnabled: false });
    expect(await screen.findByText(t("exprAiOff"))).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});
