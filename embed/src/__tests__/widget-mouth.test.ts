import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * liveface-mouth.js, the lazy bundle the widget loads for continuous-mouth
 * avatars. It must hand the avatar's mouth config on whole: that is how an
 * avatar's own performance manifest (`motion_url`) reaches the loader,
 * while the widget's `motionUrl` stays the bundled Reference motion.
 */
const attachAvatarMouth = vi.fn(async () => ({ setProfile: vi.fn(), detach: vi.fn() }));
vi.mock("../mouth", () => ({ attachAvatarMouth }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the mouth bundle", () => {
  it("passes the avatar's own manifest URL through to the loader", async () => {
    const host: { __LivefaceMouth?: { attach: (...args: unknown[]) => Promise<unknown> } } = {};
    vi.stubGlobal("window", host);
    await import("../widget-mouth");
    const engine = { setMouthExtension: vi.fn(), tuning: { mouthOpen: 1 } };
    const config = { renderer: "continuous" as const, motion_url: "https://storage.example/kit.json" };
    await host.__LivefaceMouth!.attach(engine, config, "https://api.example/mouth-motion.json");
    expect(attachAvatarMouth).toHaveBeenCalledWith(engine, config, "https://api.example/mouth-motion.json");
  });
});
