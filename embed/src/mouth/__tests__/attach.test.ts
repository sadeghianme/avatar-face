import { describe, expect, it, vi } from "vitest";

import { normalizeProfile } from "../reference-mouth-model";

/**
 * attachAvatarMouth is the one entry point shared by the dashboard, the share
 * page and the widget, so its contract is what keeps "what the owner fitted"
 * equal to "what visitors get". The loader itself needs fetch + Image, so it
 * is replaced here; the behaviour under test is what happens around it.
 */
vi.mock("../continuous-mouth", () => ({
  ContinuousMouth: {
    load: vi.fn(async () => ({ setProfile: vi.fn() })),
  },
}));

const host = () => ({ setMouthExtension: vi.fn(), tuning: { mouthOpen: 1.4 } });

describe("attachAvatarMouth", () => {
  it("fits the mouth and the engine's own opening from the saved profile", async () => {
    const { attachAvatarMouth } = await import("../index");
    const engine = host();
    await attachAvatarMouth(engine, { renderer: "continuous", profile: { jawRange: 0.7 } }, "/motion.json");
    expect(engine.setMouthExtension).toHaveBeenCalledTimes(1);
    expect(engine.tuning.mouthOpen).toBe(0.7);
  });

  it("detaching restores the classic mouth AND the owner's own tuning", async () => {
    const { attachAvatarMouth } = await import("../index");
    const engine = host();
    const attached = await attachAvatarMouth(engine, { renderer: "continuous" }, "/motion.json");
    attached.detach();
    expect(engine.setMouthExtension).toHaveBeenLastCalledWith(null);
    expect(engine.tuning.mouthOpen).toBe(1.4);
  });

  it("refits live without reloading anything", async () => {
    const { attachAvatarMouth } = await import("../index");
    const { ContinuousMouth } = await import("../continuous-mouth");
    const engine = host();
    const attached = await attachAvatarMouth(engine, { renderer: "continuous" }, "/motion.json");
    const loads = (ContinuousMouth.load as ReturnType<typeof vi.fn>).mock.calls.length;
    attached.setProfile({ jawRange: 1.0 });
    expect(engine.tuning.mouthOpen).toBe(1.0);
    expect((ContinuousMouth.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loads);
  });

  it("clamps a published profile it does not trust", async () => {
    const { attachAvatarMouth } = await import("../index");
    const engine = host();
    await attachAvatarMouth(engine, { renderer: "continuous", profile: { jawRange: 99 } }, "/motion.json");
    expect(engine.tuning.mouthOpen).toBe(normalizeProfile({ jawRange: 99 }).jawRange);
    expect(engine.tuning.mouthOpen).toBeLessThanOrEqual(1.1);
  });

  it("a failed load leaves the engine exactly as it was", async () => {
    const { attachAvatarMouth } = await import("../index");
    const { ContinuousMouth } = await import("../continuous-mouth");
    (ContinuousMouth.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    const engine = host();
    await expect(attachAvatarMouth(engine, { renderer: "continuous" }, "/motion.json")).rejects.toThrow();
    expect(engine.setMouthExtension).not.toHaveBeenCalled();
    expect(engine.tuning.mouthOpen).toBe(1.4);
  });
});
