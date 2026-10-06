import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { Avatar3DEngine } from "../engine3d";
import { morphModel, stubCanvas, stubRenderer } from "../engine3d/__tests__/three-fakes";
import type { Rig } from "../types";
import { NoopPath, fakeCanvas } from "./browser-fakes";

/**
 * The console handles (engine/debug-handle.ts): a customer's page gets no
 * globals from the engine unless it asks, and an engine that put itself on
 * `globalThis` takes itself back when it is destroyed, so an unmounted
 * engine, with its picture, textures and audio, is not kept alive.
 */

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const scope = globalThis as { __liveface?: unknown; __liveface3d?: unknown };

const photoEngine = (debug?: boolean) =>
  new AvatarEngine(fakeCanvas(), structuredClone(rig), { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement, {
    warp: "2d",
    debug,
  });

const modelEngine = (debug?: boolean) =>
  new Avatar3DEngine(stubCanvas(), morphModel(["viseme_sil", "viseme_aa"], false).root, stubRenderer().renderer, { debug });

describe("the engines' console handles", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    delete scope.__liveface;
    delete scope.__liveface3d;
    vi.unstubAllGlobals();
  });

  it("are not set unless the page asks", () => {
    const engine = photoEngine();
    const model = modelEngine();
    expect("__liveface" in globalThis).toBe(false);
    expect("__liveface3d" in globalThis).toBe(false);
    engine.destroy();
    model.destroy();
  });

  it("are set when asked, and taken back on destroy", () => {
    const engine = photoEngine(true);
    const model = modelEngine(true);
    expect(scope.__liveface).toBe(engine);
    expect(scope.__liveface3d).toBe(model);
    engine.destroy();
    model.destroy();
    expect("__liveface" in globalThis).toBe(false);
    expect("__liveface3d" in globalThis).toBe(false);
  });

  it("belong to the last engine made: destroying an older one leaves the newer one's", () => {
    const first = photoEngine(true);
    const second = photoEngine(true);
    expect(scope.__liveface).toBe(second);
    first.destroy();
    expect(scope.__liveface).toBe(second);
    second.destroy();
    expect("__liveface" in globalThis).toBe(false);
  });
});
