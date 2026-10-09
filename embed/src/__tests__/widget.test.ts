import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvatarEngine } from "../engine";
import type { LivefaceHandle, LivefacePage } from "../widget/handles";
import { FakeAudio, NoopPath, fakeCanvas, stubNetwork, type FakeNetwork, type Resource } from "./browser-fakes";

/**
 * liveface.js on a customer's page, booted as its script tag boots it: how
 * it fails (visibly under the canvas, with a console warning and a
 * `liveface:error` event, never an unhandled rejection or an error thrown
 * into the page), where the API key goes (a header, never a URL), when the
 * engine's console handle is set (only when the snippet asks), two 3D
 * widgets sharing one liveface-3d.js, and several widgets on one page, each
 * with its own handle (widget/handles.ts). Everything but the network, the
 * DOM and the canvas is the real widget and engine.
 */

const API = "https://api.example";
const KEY = "lf_secret_key";
const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8"));

const meta = (avatar: string) => `${API}/embed/v1/avatars/${avatar}`;
const RIG = "https://storage.example/avatars/av_1/rig.json?X-Amz-Signature=1";
const THUMB = "https://storage.example/avatars/av_1/thumb.webp?X-Amz-Signature=2";

/** What GET /embed/v1/avatars/{id} serves for a published photo avatar. */
const photoAvatar = {
  kind: "photo",
  framing: "full",
  rig_url: RIG,
  thumbnail_url: THUMB,
  image_url: null,
  voice: { provider: "kokoro", voice: "af_heart", locale: "fr-FR" },
  mouth: null,
};

/** An element as the widget uses one: attributes, a style, events, and
 *  what was placed right after it. */
class FakeElement {
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** What insertAdjacentElement("afterend") placed, nearest first. */
  after: FakeElement[] = [];
  events: CustomEvent[] = [];
  listeners = new Map<string, (() => void)[]>();
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  insertAdjacentElement(_where: "afterend", element: FakeElement) {
    this.after.unshift(element);
    return element;
  }
  dispatchEvent(event: CustomEvent) {
    this.events.push(event);
    return true;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** The browser finished loading this script (or failed to). */
  fire(type: "load" | "error") {
    (type === "load" ? this.onload : this.onerror)?.();
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

type Canvas = HTMLCanvasElement & FakeElement;

/** A canvas the engine can draw on that also records what the widget did
 *  around it. */
function widgetCanvas(): Canvas {
  const element = new FakeElement();
  return Object.assign(fakeCanvas(), {
    attributes: element.attributes,
    after: element.after,
    events: element.events,
    setAttribute: element.setAttribute.bind(element),
    getAttribute: element.getAttribute.bind(element),
    insertAdjacentElement: element.insertAdjacentElement.bind(element),
    dispatchEvent: element.dispatchEvent.bind(element),
  }) as unknown as Canvas;
}

interface Page {
  window: Record<string, unknown> & { Liveface?: LivefacePage };
  network: FakeNetwork;
  canvases: Canvas[];
  scripts: FakeElement[];
  /** The widgets' own script tags, in the order they were booted. */
  tags: FakeElement[];
  warnings: string[];
  errors: string[];
  /** Boot one more widget, as another script tag on the same page. */
  embed(dataset: Record<string, string>): Promise<Canvas>;
}

/** A customer's page, with the network answering `resources`. */
function page(resources: Record<string, Resource>, { search = "" } = {}): Page {
  const network = stubNetwork(resources);
  const win: Page["window"] = { devicePixelRatio: 2 };
  const canvases: Canvas[] = [];
  const scripts: FakeElement[] = [];
  const tags: FakeElement[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args) => void warnings.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { href: `https://shop.example/products/42${search}`, search });
  const doc = {
    currentScript: null as unknown,
    documentElement: { lang: "en" },
    createElement: (tag: string) => {
      if (tag !== "canvas") return new FakeElement();
      const canvas = widgetCanvas();
      canvases.push(canvas);
      return canvas;
    },
    querySelector: (selector: string) => scripts.find((s) => selector === `script[src="${s.src}"]`) ?? null,
    head: { appendChild: (script: FakeElement) => void scripts.push(script) },
  };
  vi.stubGlobal("document", doc);
  return {
    window: win,
    network,
    canvases,
    scripts,
    tags,
    warnings,
    errors,
    async embed(dataset) {
      // The widget's canvas is the one it places right after its script tag
      // (the engine makes canvases of its own).
      let placed: Canvas | undefined;
      const tag = Object.assign(new FakeElement(), {
        dataset: { key: KEY, api: API, ...dataset },
        src: `${API}/liveface.js`,
        insertAdjacentElement: (_where: string, canvas: Canvas) => void (placed = canvas),
      });
      tags.push(tag);
      doc.currentScript = tag;
      vi.resetModules();
      await import("../widget");
      await vi.waitFor(() => expect(placed).toBeDefined());
      return placed!;
    },
  };
}

/** The canvas's `liveface:*` events, by name. */
const events = (canvas: Canvas) => canvas.events.map((e) => e.type);

/** Resolves once the widget on `canvas` is up or has failed. */
const settled = (canvas: Canvas) =>
  vi.waitFor(() => expect(events(canvas).some((t) => t === "liveface:ready" || t === "liveface:error")).toBe(true));

describe("liveface.js on a customer's page", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });
  afterEach(async () => {
    // A rejection nobody handled is reported after the microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    const engine = (globalThis as { __liveface?: AvatarEngine }).__liveface;
    engine?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe("an avatar that cannot be shown", () => {
    it.each<[string, Record<string, Resource>, string, RegExp]>([
      [
        "the rig's signed URL has expired",
        { [meta("av_1")]: { json: photoAvatar }, [RIG]: { status: 403 }, [THUMB]: { image: [182, 128, 110, 255] } },
        "rig",
        /the rig request answered 403/,
      ],
      [
        "the API refuses the key",
        { [meta("av_1")]: { status: 401, error: { detail: "Invalid API key", code: "invalid_api_key" } } },
        "avatar",
        /the avatar request answered 401 \(invalid_api_key: Invalid API key\)/,
      ],
      ["the network is down", { [meta("av_1")]: { offline: true } }, "avatar", /the avatar request failed/],
      [
        "the rig is not JSON",
        {
          [meta("av_1")]: { json: photoAvatar },
          [RIG]: { status: 200 } as Resource,
          [THUMB]: { image: [182, 128, 110, 255] },
        },
        "rig",
        /the rig request answered 200/,
      ],
      [
        "its picture does not load",
        { [meta("av_1")]: { json: photoAvatar }, [RIG]: { json: rig }, [THUMB]: { broken: true } },
        "picture",
        /a picture of the avatar did not load/,
      ],
    ])("says so under the canvas when %s", async (_, resources, stage, why) => {
      const p = page(resources);
      const canvas = await p.embed({ avatar: "av_1", locale: "fr-FR" });
      await settled(canvas);

      // The page hears it, the console is warned, nothing is thrown.
      const failure = canvas.events.find((e) => e.type === "liveface:error")!;
      expect(failure.bubbles).toBe(true);
      expect(failure.detail).toMatchObject({ stage, message: expect.stringMatching(why) });
      expect(p.warnings).toEqual([expect.stringMatching(why)]);
      expect(p.errors).toEqual([]);
      // The visitor sees a note right after the canvas, which stays put.
      expect(canvas.attributes["data-liveface-state"]).toBe("error");
      const note = canvas.after[0];
      expect(note.textContent).toBe("Avatar indisponible");
      expect(note.attributes).toMatchObject({ role: "status", "data-liveface-status": "error" });
      // The page's own calls answer quietly.
      await expect(p.window.Liveface!.speak("Bonjour")).resolves.toBeUndefined();
      expect(p.window.Liveface!.isSpeaking()).toBe(false);
      expect(p.window.Liveface!.engine).toBeNull();
    });

    it("leaves another widget's working API in place", async () => {
      const p = page({
        [meta("av_1")]: { json: photoAvatar },
        [RIG]: { json: rig },
        [THUMB]: { image: [182, 128, 110, 255] },
        [meta("av_2")]: {
          status: 404,
          error: { detail: "Avatar has not been published", code: "avatar_not_published" },
        },
      });
      await settled(await p.embed({ avatar: "av_1" }));
      const working = p.window.Liveface;
      expect(working?.engine).not.toBeNull();
      const broken = await p.embed({ avatar: "av_2" });
      await settled(broken);
      expect(events(broken)).toEqual(["liveface:error"]);
      expect(p.window.Liveface).toBe(working);
      (working!.engine as AvatarEngine).destroy();
    });
  });

  describe("an avatar that is shown", () => {
    const resources = {
      [meta("av_1")]: { json: photoAvatar },
      [RIG]: { json: rig },
      [THUMB]: { image: [182, 128, 110, 255] as const },
    };

    it("says it is ready, and sends the key only in a header", async () => {
      const p = page(resources as Record<string, Resource>);
      const canvas = await p.embed({ avatar: "av_1" });
      await settled(canvas);
      expect(events(canvas)).toEqual(["liveface:ready"]);
      expect(canvas.attributes["data-liveface-state"]).toBe("ready");
      expect(canvas.after).toEqual([]);
      expect(p.warnings).toEqual([]);
      // The key never in a URL, where access logs, proxies and Referer
      // headers would keep it; in the X-Api-Key header of the API's calls.
      expect(p.network.requested.filter((url) => url.includes(KEY))).toEqual([]);
      expect(p.network.fetches.find((f) => f.url === meta("av_1"))?.headers).toEqual({ "X-Api-Key": KEY });
      (p.window.Liveface!.engine as AvatarEngine).destroy();
    });

    it("puts no engine on globalThis unless the snippet asks", async () => {
      const p = page(resources as Record<string, Resource>);
      await settled(await p.embed({ avatar: "av_1" }));
      expect("__liveface" in globalThis).toBe(false);
      (p.window.Liveface!.engine as AvatarEngine).destroy();
    });

    it.each([
      ["data-debug on the snippet", { debug: "" }, ""],
      ["?liveface-debug in the page's URL", {}, "?liveface-debug"],
    ])("puts the engine on globalThis.__liveface for %s, until it is destroyed", async (_, dataset, search) => {
      const p = page(resources as Record<string, Resource>, { search });
      await settled(await p.embed({ avatar: "av_1", ...dataset }));
      const engine = p.window.Liveface!.engine as AvatarEngine;
      expect((globalThis as { __liveface?: unknown }).__liveface).toBe(engine);
      engine.destroy();
      expect("__liveface" in globalThis).toBe(false);
    });

    it.each([
      ["without data-head-motion, the avatar's own (a photo's: the turn in depth)", {}, "3d"],
      ['with data-head-motion="2d", the rigid layer', { headMotion: "2d" }, "2d"],
      ['with data-head-motion=" 3D ", the turn in depth', { headMotion: " 3D " }, "3d"],
      ["with a data-head-motion it does not know, the avatar's own", { headMotion: "wobble" }, "3d"],
    ])("moves the head %s", async (_, dataset, mode) => {
      const p = page(resources as Record<string, Resource>);
      await settled(await p.embed({ avatar: "av_1", ...dataset }));
      const engine = p.window.Liveface!.engine as AvatarEngine;
      expect(engine.headMotion()).toBe(mode);
      engine.destroy();
    });

    // The rig in these is a person's with no render profile, as a cat's or a
    // cartoon's fitted before profiles existed is: only the published face
    // type tells them apart.
    it.each([
      ["a person's", "human", {}, "3d"],
      ["an animal's", "animal", {}, "2d"],
      ["a cartoon's", "cartoon", {}, "2d"],
      ['an animal\'s, with data-head-motion="3d"', "animal", { headMotion: "3d" }, "3d"],
      ['a person\'s, with data-head-motion="2d"', "human", { headMotion: "2d" }, "2d"],
    ])("moves the head by the published face type: %s", async (_, faceType, dataset, mode) => {
      const p = page({
        ...resources,
        [meta("av_1")]: { json: { ...photoAvatar, face_type: faceType } },
      } as Record<string, Resource>);
      await settled(await p.embed({ avatar: "av_1", ...dataset }));
      const engine = p.window.Liveface!.engine as AvatarEngine;
      expect(engine.headMotion()).toBe(mode);
      engine.destroy();
    });

    it('keeps the handle off for data-debug="off"', async () => {
      const p = page(resources as Record<string, Resource>);
      await settled(await p.embed({ avatar: "av_1", debug: "off" }));
      expect("__liveface" in globalThis).toBe(false);
      (p.window.Liveface!.engine as AvatarEngine).destroy();
    });
  });

  describe("two 3D avatars on one page", () => {
    const model = (avatar: string) => ({
      ...photoAvatar,
      kind: "model3d",
      model_url: `https://storage.example/${avatar}.glb`,
    });

    it("share one liveface-3d.js, and the second waits for it to load", async () => {
      const p = page({ [meta("m_1")]: { json: model("m_1") }, [meta("m_2")]: { json: model("m_2") } });
      const first = await p.embed({ avatar: "m_1" });
      await vi.waitFor(() => expect(p.scripts).toHaveLength(1));
      const second = await p.embed({ avatar: "m_2", debug: "" });
      const tag = p.scripts[0];
      // The second widget found the first's tag, still loading, and waits on it.
      await vi.waitFor(() => expect(tag.listeners.get("load")).toHaveLength(1));
      expect(p.scripts).toHaveLength(1);
      expect(events(first)).toEqual([]);
      expect(events(second)).toEqual([]);

      // The bundle runs.
      const load = vi.fn(async () => ({ tuning: {}, playAudio() {}, stopSpeech() {}, isSpeaking: () => false }));
      p.window.__Liveface3D = { load };
      tag.fire("load");
      await settled(first);
      await settled(second);
      expect(events(first)).toEqual(["liveface:ready"]);
      expect(events(second)).toEqual(["liveface:ready"]);
      expect(load.mock.calls).toEqual([
        [first, "https://storage.example/m_1.glb", { debug: false }],
        [second, "https://storage.example/m_2.glb", { debug: true }],
      ]);
      expect(p.errors).toEqual([]);
    });

    it("both say so when liveface-3d.js does not load", async () => {
      const p = page({ [meta("m_1")]: { json: model("m_1") }, [meta("m_2")]: { json: model("m_2") } });
      const first = await p.embed({ avatar: "m_1" });
      await vi.waitFor(() => expect(p.scripts).toHaveLength(1));
      const second = await p.embed({ avatar: "m_2" });
      await vi.waitFor(() => expect(p.scripts[0].listeners.get("error")).toHaveLength(1));
      p.scripts[0].fire("error");
      await settled(first);
      await settled(second);
      for (const canvas of [first, second]) {
        expect(canvas.events.map((e) => [e.type, e.detail?.stage])).toEqual([["liveface:error", "model"]]);
      }
      // A third widget, after the fact, does not wait for a load that is over.
      const third = await p.embed({ avatar: "m_1" });
      await settled(third);
      expect(events(third)).toEqual(["liveface:error"]);
    });
  });

  describe("several widgets on one page", () => {
    const SYNTH = `${API}/embed/v1/synthesize`;
    const cues = JSON.parse(readFileSync(new URL("./fixtures/native-cues-hello.json", import.meta.url), "utf8")).cues;
    const resources = {
      [meta("av_1")]: { json: photoAvatar },
      [meta("av_2")]: { json: { ...photoAvatar, voice: { provider: "kokoro", voice: "am_adam", locale: "en-US" } } },
      [meta("m_1")]: { json: { ...photoAvatar, kind: "model3d", model_url: "https://storage.example/m_1.glb" } },
      [meta("gone")]: { status: 404, error: { detail: "Avatar has not been published", code: "avatar_not_published" } },
      [RIG]: { json: rig },
      [THUMB]: { image: [182, 128, 110, 255] },
      [SYNTH]: { json: { audio_b64: "AAAA", audio_mime: "audio/wav", duration_ms: 1200, cues, cached: false } },
    } as Record<string, Resource>;

    /** Every engine of the page's widgets, given back. */
    const destroyAll = (p: Page) => {
      for (const handle of p.window.Liveface?.all() ?? []) (handle.engine as AvatarEngine | null)?.destroy?.();
    };

    it("gives each its own handle: Liveface.get by avatar, canvas or script tag, Liveface.all in order", async () => {
      const p = page(resources);
      const first = await p.embed({ avatar: "av_1" });
      await settled(first);
      const second = await p.embed({ avatar: "av_2" });
      await settled(second);
      const Liveface = p.window.Liveface!;
      const all = Liveface.all();
      expect(all.map((h) => h.avatar)).toEqual(["av_1", "av_2"]);
      const [one, other] = all;
      expect(one.canvas).toBe(first);
      expect(other.canvas).toBe(second);
      expect(one.engine).not.toBe(other.engine);
      expect(Liveface.get("av_2")).toBe(other);
      expect(Liveface.get(second)).toBe(other);
      expect(Liveface.get(p.tags[1] as unknown as Element)).toBe(other);
      expect(Liveface.get(p.tags[0] as unknown as Element)).toBe(one);
      expect(Liveface.get("av_9")).toBeNull();
      expect(Liveface.get(null)).toBeNull();
      // window.Liveface's own calls are the first widget's, as with one.
      expect(Liveface.engine).toBe(one.engine);
      destroyAll(p);
    });

    it("hands each widget's handle to the page in liveface:ready: on its canvas, bubbling, and its script tag, not", async () => {
      const p = page(resources);
      const canvas = await p.embed({ avatar: "av_2" });
      await settled(canvas);
      const handle = p.window.Liveface!.get("av_2")!;
      const onCanvas = canvas.events.find((e) => e.type === "liveface:ready")!;
      expect(onCanvas.detail).toBe(handle);
      expect(onCanvas.bubbles).toBe(true);
      const onTag = p.tags[0].events.find((e) => e.type === "liveface:ready")!;
      expect(onTag.detail).toBe(handle);
      expect(onTag.bubbles).toBe(false);
      destroyAll(p);
    });

    it("tunes one widget without the other; Liveface.tune is the first's", async () => {
      const p = page(resources);
      await settled(await p.embed({ avatar: "av_1" }));
      await settled(await p.embed({ avatar: "av_2" }));
      const Liveface = p.window.Liveface!;
      const [one, other] = Liveface.all() as LivefaceHandle[];
      other.tune({ mouthOpen: 1.4 });
      expect(other.engine!.tuning.mouthOpen).toBe(1.4);
      expect(one.engine!.tuning.mouthOpen).toBe(1);
      Liveface.tune({ mouthOpen: 0.7 });
      expect(one.engine!.tuning.mouthOpen).toBe(0.7);
      expect(other.engine!.tuning.mouthOpen).toBe(1.4);
      destroyAll(p);
    });

    it("shows an expression on one widget; Liveface.express is the first's, and tags never reach the voice", async () => {
      vi.stubGlobal("Audio", FakeAudio);
      const p = page(resources);
      await settled(await p.embed({ avatar: "av_1" }));
      await settled(await p.embed({ avatar: "av_2" }));
      const Liveface = p.window.Liveface!;
      const [one, other] = Liveface.all() as LivefaceHandle[];
      other.express("smile", 0.6);
      expect((other.engine as AvatarEngine).expression).toMatchObject({ name: "happy", intensity: 0.6 });
      expect((one.engine as AvatarEngine).expression.name).toBe("neutral");
      Liveface.express("surprised");
      expect((one.engine as AvatarEngine).expression.name).toBe("surprised");
      one.express("not-an-expression");
      expect((one.engine as AvatarEngine).expression.name).toBe("surprised");

      void one.speak("Hello there, [happy:0.5] my friend, how are you today?");
      await vi.waitFor(() => expect(one.engine!.isSpeaking()).toBe(true));
      const sent = JSON.parse(p.network.fetches.find((f) => f.url === SYNTH)!.body!);
      expect(sent).toMatchObject({ text: "Hello there, my friend, how are you today?", word_marks: true });
      one.stop();
      destroyAll(p);
    });

    it("speaks with each widget's own key and voice, and stops one while the other speaks on", async () => {
      vi.stubGlobal("Audio", FakeAudio);
      const p = page(resources);
      await settled(await p.embed({ avatar: "av_1", key: "lf_first" }));
      await settled(await p.embed({ avatar: "av_2", key: "lf_second" }));
      const Liveface = p.window.Liveface!;
      const one = Liveface.get("av_1")!;
      const other = Liveface.get("av_2")!;

      void one.speak("Bonjour à tous.");
      await vi.waitFor(() => expect(one.isSpeaking()).toBe(true));
      expect(other.isSpeaking()).toBe(false);
      void other.speak("Hello everyone.");
      await vi.waitFor(() => expect(other.engine!.isSpeaking()).toBe(true));
      expect(one.engine!.isSpeaking()).toBe(true);
      // Each through its own snippet's key.
      const synths = p.network.fetches.filter((f) => f.url === SYNTH).map((f) => f.headers["X-Api-Key"]);
      expect(synths).toEqual(["lf_first", "lf_second"]);

      one.stop();
      expect(one.isSpeaking()).toBe(false);
      expect(one.engine!.isSpeaking()).toBe(false);
      expect(other.isSpeaking()).toBe(true);
      expect(other.engine!.isSpeaking()).toBe(true);
      // window.Liveface's own calls stay the first widget's.
      expect(Liveface.isSpeaking()).toBe(false);
      other.stop();
      expect(other.isSpeaking()).toBe(false);
      destroyAll(p);
    });

    it("a line the server refuses rejects speak() with the API's code, detail and status", async () => {
      const detail = "This line has not been rendered in the cloned voice 'Mehdi voice' yet.";
      const p = page({ ...resources, [SYNTH]: { status: 404, error: { detail, code: "cloned_line_missing" } } });
      await settled(await p.embed({ avatar: "av_1" }));
      const refusal = await p.window.Liveface!.speak("Never rendered.").catch((reason: unknown) => reason);
      expect(refusal).toMatchObject({ name: "SpeechError", code: "cloned_line_missing", detail, status: 404 });
      expect(String(refusal)).toBe(`SpeechError: ${detail} (404 cloned_line_missing)`);
      destroyAll(p);
    });

    it("a photo and a 3D avatar side by side: each its own engine, in the order they came up", async () => {
      const p = page(resources);
      const model = await p.embed({ avatar: "m_1" });
      await vi.waitFor(() => expect(p.scripts).toHaveLength(1));
      const photo = await p.embed({ avatar: "av_1" });
      await settled(photo);
      // The photo comes up first: the 3D bundle is still loading.
      expect(p.window.Liveface!.all().map((h) => h.avatar)).toEqual(["av_1"]);
      const engine3d = { tuning: { mouthOpen: 1 }, playAudio() {}, stopSpeech() {}, isSpeaking: () => false };
      p.window.__Liveface3D = { load: async () => engine3d };
      p.scripts[0].fire("load");
      await settled(model);
      const Liveface = p.window.Liveface!;
      expect(Liveface.all().map((h) => h.avatar)).toEqual(["av_1", "m_1"]);
      expect(Liveface.get("m_1")!.engine).toBe(engine3d);
      expect(Liveface.get(model)!.engine).toBe(engine3d);
      expect(Liveface.get("av_1")!.engine).not.toBe(engine3d);
      // The first to come up is window.Liveface's, whatever the page's order.
      expect(Liveface.engine).toBe(Liveface.get("av_1")!.engine);
      Liveface.get("m_1")!.tune({ mouthOpen: 1.5 });
      expect(engine3d.tuning.mouthOpen).toBe(1.5);
      // No expressions on a 3D avatar yet: a quiet no-op.
      expect(() => Liveface.get("m_1")!.express("happy")).not.toThrow();
      (Liveface.get("av_1")!.engine as AvatarEngine).destroy();
    });

    it("leaves a widget that failed out of Liveface.all and Liveface.get, and tells its script tag", async () => {
      const p = page(resources);
      const broken = await p.embed({ avatar: "gone" });
      await settled(broken);
      // Up before any widget is: window.Liveface answers quietly.
      expect(p.window.Liveface!.all()).toEqual([]);
      expect(p.window.Liveface!.engine).toBeNull();
      expect(p.tags[0].events.map((e) => [e.type, e.bubbles, e.detail?.stage])).toEqual([
        ["liveface:error", false, "avatar"],
      ]);
      const working = await p.embed({ avatar: "av_1" });
      await settled(working);
      const Liveface = p.window.Liveface!;
      expect(Liveface.all().map((h) => h.avatar)).toEqual(["av_1"]);
      expect(Liveface.get("gone")).toBeNull();
      expect(Liveface.get(broken)).toBeNull();
      // The working one is window.Liveface's now.
      expect(Liveface.engine).toBe(Liveface.get("av_1")!.engine);
      destroyAll(p);
    });
  });
});
