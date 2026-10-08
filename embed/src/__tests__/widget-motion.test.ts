import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import { attachedMouthSeam } from "../mouth/seam";
import { fakeCanvas, NoopPath, stubNetwork, type FakeNetwork, type Resource } from "./browser-fakes";

/**
 * From a published config to the mouth a visitor sees. liveface.js reads the
 * avatar's `mouth` from the embed API, loads liveface-mouth.js for a
 * continuous mouth and hands it the config whole; the avatar's own
 * performance manifest (`mouth.motion_url`, version 2) must reach the
 * continuous mouth, and one that does not load must leave the bundled
 * Reference motion playing, not the classic mouth. An avatar without a
 * teeth photo of its own gets the standard teeth, from the API beside the
 * bundled motion. Everything but the network and the canvas is the real
 * widget, engine and mouth code.
 */

const API = "https://api.example";
const AVATAR = "av_1";
const BUNDLED = `${API}/mouth-motion.json`;
/** The standard teeth, which the API serves beside BUNDLED. */
const STANDARD = [`${API}/mouth-teeth.webp`, `${API}/mouth-teeth.rig.json`];
/** The customer's page the widget is on: another site than the API's. */
const PAGE = "https://shop.example/products/42";
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
  engine: AvatarEngine;
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
        dispatchEvent: () => true,
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

/** The continuous mouth the engine draws with, through its seam (null for
 *  the classic mouth). */
const mouthIn = (engine: AvatarEngine) => attachedMouthSeam(engineSeam(engine).mouthExtension);

/** The mouth the engine draws with now, by the motion it plays. */
function mouthOf(engine: AvatarEngine): string | null {
  return mouthIn(engine)?.character ?? null;
}

/** Whether the engine's mouth draws its teeth from a photo. */
function teethPhotoOf(engine: AvatarEngine): boolean {
  return mouthIn(engine)?.teethPhoto ?? false;
}

describe("the widget's continuous mouth", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("location", { href: PAGE });
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

  it("draws the standard teeth, from the API, for an avatar without a teeth photo of its own", async () => {
    const mouth = { renderer: "continuous", profile: { jawRange: 0.7 }, oral: null, motion_url: KIT };
    const { network, attached } = await embed(published(mouth), {
      [KIT]: { json: avatarMotion },
      [STANDARD[0]]: { image: [236, 228, 214, 255] },
      [STANDARD[1]]: { json: teethRig },
    });
    await attached.done;
    expect(mouthOf(attached.engine)).toBe("avatar-v1:contract-fixture");
    expect(teethPhotoOf(attached.engine)).toBe(true);
    // Beside the bundled motion the widget names (`${apiBase}/…`), not
    // beside the customer's page; each once, and the motion not at all.
    expect(network.requested.filter((url) => [KIT, BUNDLED, ...STANDARD].includes(url))).toEqual([KIT, ...STANDARD]);
    expect(network.requested.some((url) => url.startsWith("https://shop.example"))).toBe(false);
  });

  it("keeps the continuous mouth, with drawn teeth, where the standard teeth do not load", async () => {
    const mouth = { renderer: "continuous", profile: {}, oral: null };
    const { network, attached } = await embed(published(mouth), { [STANDARD[0]]: { status: 404 } });
    await attached.done;
    expect(mouthOf(attached.engine)).toBe("lab-reference-v1");
    expect(teethPhotoOf(attached.engine)).toBe(false);
    expect(network.requested.filter((url) => STANDARD.includes(url))).toEqual([STANDARD[0]]);
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
    const mouthFiles = network.requested.filter((url) =>
      [KIT, BUNDLED, oral.image_url, oral.rig_url, ...STANDARD].includes(url)
    );
    // Its own photo refused is not replaced by the standard teeth: the
    // owner's choice of teeth is not overruled on visitors' pages.
    expect(mouthFiles).toEqual([KIT, oral.image_url, oral.rig_url]);
  });
});
