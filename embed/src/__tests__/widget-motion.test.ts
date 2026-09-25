import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCanvas, NoopPath, stubNetwork, type FakeNetwork, type Resource } from "./browser-fakes";

/**
 * From a published config to the mouth a visitor sees. liveface.js reads the
 * avatar's `mouth` from the embed API, loads liveface-mouth.js for a
 * continuous mouth and hands it the config whole; the avatar's own
 * performance manifest (`mouth.motion_url`, version 2) must reach the
 * continuous mouth, and one that does not load must leave the bundled
 * Reference motion playing, not the classic mouth. Everything but the
 * network and the canvas is the real widget, engine and mouth code.
 */

const API = "https://api.example";
const AVATAR = "av_1";
const BUNDLED = `${API}/mouth-motion.json`;
const KIT = "https://storage.example/avatars/av_1/motion-v2.json?X-Amz-Signature=4";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const bundled = read("../../assets/mouth-motion.json");
const avatarMotion = read("../mouth/__tests__/fixtures/avatar-motion.json");
const rig = read("./fixtures/human-rig.json");

/** A teeth photo's rig: the Reference saying AA, lips apart. */
const teethRig = {
  image_size: [1000, 1000],
  points: bundled.poses[1].points.map(([x, y]: number[]) => [x * 1000, y * 1000]),
  inner_lip_ring: bundled.inner_ring,
  outer_lip_ring: bundled.outer_ring,
};

/** What GET /embed/v1/avatars/{id} serves for a published photo avatar. */
const published = (mouth: object) => ({
  kind: "photo",
  framing: "full",
  rig_url: "https://storage.example/avatars/av_1/rig.json?X-Amz-Signature=1",
  thumbnail_url: "https://storage.example/avatars/av_1/thumb.webp?X-Amz-Signature=2",
  image_url: null,
  voice: { provider: "kokoro", voice: "af_heart", locale: "en-US" },
  mouth,
});

interface Attached {
  engine: { tuning: { mouthOpen: number } };
  config: unknown;
  motionUrl: string;
  /** What attach returned: settles once the mouth has loaded, or not. */
  done: Promise<unknown>;
}

/**
 * Boot liveface.js as its script tag does, and resolve with the call the
 * widget makes to the mouth bundle, once the bundle has loaded.
 */
async function embed(info: ReturnType<typeof published>, answers: Record<string, Resource>) {
  const network: FakeNetwork = stubNetwork({
    [`${API}/embed/v1/avatars/${AVATAR}`]: { json: info },
    [info.rig_url]: { json: rig },
    [info.thumbnail_url]: { image: [182, 128, 110, 255] },
    [BUNDLED]: { json: bundled },
    ...answers,
  });
  const page: Record<string, unknown> = { devicePixelRatio: 2 };
  const scripts: string[] = [];
  const attached = new Promise<Attached>((resolve, reject) => {
    vi.spyOn(console, "error").mockImplementation((...args) => reject(new Error(args.join(" "))));
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", {
      currentScript: {
        dataset: { avatar: AVATAR, key: "lf_test", api: API },
        src: `${API}/liveface.js`,
        insertAdjacentElement() {},
      },
      createElement: (tag: string) => (tag === "canvas" ? fakeCanvas() : { dataset: {} }),
      querySelector: () => null,
      head: {
        // The browser runs liveface-mouth.js: here, the real bundle, with
        // its attach watched on the way through.
        appendChild(script: { src: string; onload: () => void }) {
          scripts.push(script.src);
          void import("../widget-mouth").then(() => {
            const bundle = page.__LivefaceMouth as { attach: (...args: unknown[]) => Promise<unknown> };
            const attach = bundle.attach;
            bundle.attach = (engine, config, motionUrl) => {
              const done = attach(engine, config, motionUrl);
              resolve({ engine: engine as Attached["engine"], config, motionUrl: motionUrl as string, done });
              return done;
            };
            script.onload();
          }, reject);
        },
      },
    });
  });
  await import("../widget");
  return { network, scripts, attached: await attached };
}

/** The mouth the engine draws with now, and the motion it plays. */
function mouthOf(engine: unknown): string | null {
  const extension = (engine as { mouthExtension?: { template: { character: string } } }).mouthExtension;
  return extension ? extension.template.character : null;
}

describe("the widget's continuous mouth", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("plays the avatar's own performance manifest, named in its published config", async () => {
    const mouth = { renderer: "continuous", profile: { jawRange: 0.7 }, oral: null, motion_url: KIT };
    const { network, scripts, attached } = await embed(published(mouth), { [KIT]: { json: avatarMotion } });
    expect(scripts).toEqual([`${API}/liveface-mouth.js`]);
    // Handed on whole: the manifest URL rides in the config, and the bundled
    // Reference motion is only the fallback.
    expect(attached.config).toEqual(mouth);
    expect(attached.motionUrl).toBe(BUNDLED);
    await attached.done;
    expect(mouthOf(attached.engine)).toBe("avatar-v1:contract-fixture");
    expect(attached.engine.tuning.mouthOpen).toBe(0.7);
    expect(network.requested).toContain(KIT);
    expect(network.requested).not.toContain(BUNDLED);
  });

  it.each<[string, Resource]>([
    ["404s", { status: 404 }],
    ["fails validation", { json: { ...avatarMotion, poses: avatarMotion.poses.slice(0, 6) } }],
  ])("plays the bundled Reference motion when the avatar's own manifest %s", async (_, answer) => {
    const mouth = { renderer: "continuous", profile: { jawRange: 0.7 }, oral: null, motion_url: KIT };
    const { network, attached } = await embed(published(mouth), { [KIT]: answer });
    await attached.done;
    expect(mouthOf(attached.engine)).toBe("lab-reference-v1");
    expect(attached.engine.tuning.mouthOpen).toBe(0.7);
    expect(network.requested.filter((url) => url === KIT || url === BUNDLED)).toEqual([KIT, BUNDLED]);
  });

  it("plays the bundled motion, as before, for a config published without a manifest", async () => {
    const mouth = { renderer: "continuous", profile: {}, oral: null };
    const { network, attached } = await embed(published(mouth), {});
    await attached.done;
    expect(mouthOf(attached.engine)).toBe("lab-reference-v1");
    expect(network.requested).toContain(BUNDLED);
  });

  it("keeps the classic mouth for a teeth photo it cannot draw, downloading nothing twice", async () => {
    const oral = {
      image_url: "https://storage.example/avatars/av_1/oral.webp?X-Amz-Signature=5",
      rig_url: "https://storage.example/avatars/av_1/oral.rig.json?X-Amz-Signature=6",
    };
    const mouth = { renderer: "continuous", profile: {}, oral, motion_url: KIT };
    const { network, attached } = await embed(published(mouth), {
      [KIT]: { json: avatarMotion },
      // Lips over the gap where the teeth should be: the teeth surface
      // refuses it, as it refuses any photo without clear upper teeth.
      [oral.image_url]: { image: [150, 90, 84, 255] },
      [oral.rig_url]: { json: teethRig },
    });
    await expect(attached.done).rejects.toMatchObject({ name: "DentalPhotoError" });
    expect(mouthOf(attached.engine)).toBeNull();
    const mouthFiles = network.requested.filter((url) => [KIT, BUNDLED, oral.image_url, oral.rig_url].includes(url));
    expect(mouthFiles).toEqual([KIT, oral.image_url, oral.rig_url]);
  });
});
