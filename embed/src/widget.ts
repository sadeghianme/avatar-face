/**
 * liveface.js — auto-bootstrapping embed widget.
 *
 *   <script src="https://api.example.com/liveface.js"
 *           data-avatar="AVATAR_ID"
 *           data-key="lf_..."
 *           data-api="https://api.example.com"
 *           data-voice="af_heart"
 *           data-provider="kokoro"></script>
 *
 * Renders a canvas where the script tag sits and exposes window.Liveface:
 *   Liveface.speak(text)  — chunked + prefetched for long text
 *   Liveface.stop()
 *   Liveface.isSpeaking()
 *   Liveface.listen({lang}) — browser STT, resolves with the transcript
 *   Liveface.sttSupported()
 *
 * The key travels in the X-Api-Key header, never in a URL (where it would
 * reach access logs, proxies and Referer headers).
 *
 * An avatar whose face an AI made or changed shows a small "AI avatar"
 * label under the canvas (see widget/disclosure.ts); data-ai-label="off"
 * turns it off for a site that discloses it another way.
 *
 * An avatar that cannot be shown (the API refuses the key, a signed URL
 * expired, a picture does not load) leaves a short note under the canvas,
 * a console warning and a `liveface:error` event on the canvas
 * (widget/failure.ts); `liveface:ready` says it is up. Nothing is thrown
 * into the host page.
 *
 * data-debug on the snippet (or ?liveface-debug in the page's URL) puts the
 * engine on globalThis.__liveface for the console (engine/debug-handle.ts).
 */
import { BrowserTTS } from "./browser-tts";
import { aiLabel, renderAiLabel, type Disclosure } from "./disclosure";
import { AvatarEngine, type Scene } from "./engine";
import type { Avatar3DEngine, Avatar3DOptions } from "./engine3d";
import { SpeechPlayer, SpeechQueue } from "./speech";
import { listen, sttSupported, ListenOptions } from "./stt";
import type { ClassicMouthConfig } from "./character-mouth";
import type { AvatarMouthConfig } from "./mouth";
import { EngineTuning, Rig, SynthesisPayload } from "./types";
import { showFailure } from "./widget/failure";
import { asFailure, fetchJson, loadImage, loadScript } from "./widget/load";

interface LivefaceApi {
  speak(text: string): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
  listen(options?: ListenOptions): Promise<string>;
  sttSupported(): boolean;
  /** Adjust animation live, e.g. Liveface.tune({ mouthOpen: 1.3 }). */
  tune(partial: Partial<EngineTuning>): void;
  engine: SpeechPlayer | null;
}

declare global {
  interface Window {
    Liveface?: LivefaceApi;
    __Liveface3D?: {
      load: (canvas: HTMLCanvasElement, modelUrl: string, options?: Avatar3DOptions) => Promise<Avatar3DEngine>;
    };
    /** Set by liveface-mouth.js, loaded only for avatars that use it.
     *  `motionUrl` is the bundled Reference motion; `config.motion_url`, when
     *  present, is the avatar's own. */
    __LivefaceMouth?: {
      attach: (engine: AvatarEngine, config: AvatarMouthConfig, motionUrl: string) => Promise<unknown>;
    };
  }
}

/** What GET /embed/v1/avatars/{id} answers (backend/app/api/embed.py). */
interface PublishedAvatar {
  kind?: string;
  framing?: string;
  /** The published scene (zoom, pan, background), or null for a snapshot
   *  from before scenes existed. */
  scene?: Scene | null;
  rig_url: string;
  thumbnail_url: string;
  image_url?: string | null;
  model_url?: string | null;
  layer_urls?: { background?: string; body: string; head: string } | null;
  voice?: { provider: string; voice: string; locale: string } | null;
  mouth?: AvatarMouthConfig | ClassicMouthConfig | null;
  /** Absent for snapshots published before disclosures were recorded. */
  disclosure?: Disclosure;
}

/** A data-* switch: present and not "off", "false" or "0". */
function switchedOn(value: string | undefined): boolean {
  return value !== undefined && !["off", "false", "0"].includes(value.trim().toLowerCase());
}

/** window.Liveface for an avatar that could not be shown: the page's calls
 *  answer quietly (nothing to say, nothing speaking) instead of throwing. */
const UNAVAILABLE: LivefaceApi = {
  speak: () => Promise.resolve(),
  stop: () => undefined,
  isSpeaking: () => false,
  listen: (options?: ListenOptions) => listen(options),
  sttSupported,
  tune: () => undefined,
  engine: null,
};

async function bootstrap(script: HTMLScriptElement): Promise<void> {
  const avatarId = script.dataset.avatar;
  const apiKey = script.dataset.key;
  const apiBase = (script.dataset.api ?? new URL(script.src).origin).replace(/\/$/, "");
  if (!avatarId || !apiKey) {
    console.error("[liveface] missing data-avatar or data-key");
    return;
  }
  const sizeAttr = Number(script.dataset.size ?? 320);
  const size = Number.isFinite(sizeAttr) && sizeAttr > 0 ? sizeAttr : 320;

  const canvas = document.createElement("canvas");
  // The backing store is in DEVICE pixels: at the default 320 CSS pixels a
  // tooth is ~4.5px wide, and drawn into CSS pixels the teeth, the lip-depth
  // bands and the corner fade averaged away. Capped at 3: the texture is the
  // full-resolution photo, which a 3x store still shows more of; past that
  // the fill cost is real and the gain is not visible. (The 3D path sets
  // its own ratio.)
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  // Lay out at the requested CSS size; `auto` height keeps it square under
  // the max-width, so narrow containers still shrink it without distortion.
  canvas.style.width = `${size}px`;
  canvas.style.height = "auto";
  canvas.style.maxWidth = "100%";
  canvas.setAttribute("data-liveface", avatarId);
  script.insertAdjacentElement("afterend", canvas);

  try {
    await mount(script, canvas, { avatarId, apiKey, apiBase });
  } catch (error) {
    // Until the avatar's own locale is known, the note speaks the snippet's
    // language, else the page's.
    const locale = script.dataset.locale || document.documentElement?.lang || "en";
    showFailure(canvas, asFailure(error, "engine"), locale);
    // A page that calls Liveface.speak() gets a quiet answer, not a
    // TypeError; another widget's working API is left in place.
    window.Liveface ??= UNAVAILABLE;
  }
}

/** Everything after the canvas is in place: the avatar fetched and drawn,
 *  window.Liveface set. Throws (a WidgetFailure, mostly) when it cannot. */
async function mount(
  script: HTMLScriptElement,
  canvas: HTMLCanvasElement,
  { avatarId, apiKey, apiBase }: { avatarId: string; apiKey: string; apiBase: string }
): Promise<void> {
  // Voice precedence: explicit data-* attributes on the snippet win (that
  // is per-site intent), then the avatar's PUBLISHED voice from the meta
  // response below (so changing it in the dashboard and publishing reaches
  // every embedding site), then the server-voice default.
  let provider = script.dataset.provider ?? "";
  let voice = script.dataset.voice ?? "";
  let locale = script.dataset.locale ?? "";
  // The console handle (engine/debug-handle.ts): off unless asked for.
  const debug = switchedOn(script.dataset.debug) || new URLSearchParams(location.search).has("liveface-debug");

  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
  const info = await fetchJson<PublishedAvatar>(`${apiBase}/embed/v1/avatars/${avatarId}`, "avatar", {
    headers: { "X-Api-Key": apiKey },
  });

  if (!provider) {
    provider = info.voice?.provider ?? "kokoro";
    voice = voice || (info.voice?.voice ?? (provider === "kokoro" ? "af_heart" : ""));
  }
  if (!voice && provider === "offline") voice = "offline-warm";
  if (!locale) locale = info.voice?.locale ?? "en-US";

  // Told before the face appears, not after it has started talking.
  const label = aiLabel(info.disclosure, locale, script.dataset.aiLabel);
  if (label) renderAiLabel(canvas, label);

  let engine: AvatarEngine | Avatar3DEngine;
  if (info.kind === "model3d" && info.model_url) {
    // 3D avatar: lazy-load the Three.js bundle, then hand it the GLB.
    await loadScript(`${apiBase}/liveface-3d.js`, () => !!window.__Liveface3D, "model");
    engine = await window.__Liveface3D!.load(canvas, info.model_url, { debug });
  } else {
    // Progressive texture: boot on whichever image lands first — usually the
    // 256px thumbnail, tens of KB — so a face appears and starts animating
    // immediately, then upgrade in place to the full-resolution photo. The
    // full image is what the avatar must end on: the canvas backing store is
    // 2-3x the CSS size, and rendering the thumbnail into it permanently was
    // an upscale of a postage stamp while the sharp original sat in storage.
    const fullUrl = info.image_url || info.thumbnail_url;
    const thumbPromise = loadImage(info.thumbnail_url);
    const fullPromise = fullUrl === info.thumbnail_url ? null : loadImage(fullUrl);
    const [rig, first] = await Promise.all([
      fetchJson<Rig>(info.rig_url, "rig"),
      fullPromise
        ? Promise.race([thumbPromise, fullPromise]).catch(() => thumbPromise)
        : thumbPromise,
    ]);
    // The zoom: data-zoom on the snippet wins, then data-framing (face is
    // 1, full 0), then the avatar's published scene, then its framing — so
    // what the owner sets in the dashboard reaches sites already embedding
    // it, and a site that says otherwise keeps its say. The scene's pan
    // and background come with it either way.
    const zoomAttr = Number(script.dataset.zoom);
    const framingAttr = script.dataset.framing;
    const zoom = script.dataset.zoom !== undefined && Number.isFinite(zoomAttr)
      ? zoomAttr
      : framingAttr ? (framingAttr === "full" ? 0 : 1) : undefined;
    const photoEngine = new AvatarEngine(canvas, rig, first, {
      fullPhoto: info.framing === "full",
      scene: info.scene ?? undefined,
      zoom,
      // data-warp="2d" keeps the mesh on the Canvas 2D path (warp-gl.ts):
      // for a site that must not use WebGL, and for comparing the two.
      warp: script.dataset.warp === "2d" ? "2d" : undefined,
      debug,
    });
    engine = photoEngine;
    // How the owner set a character mouth (jaw, teeth, tongue); a classic
    // mouth ignores it.
    if (info.mouth?.renderer === "classic") photoEngine.setCharacterTraits(info.mouth.character);
    void fullPromise
      ?.then((img) => {
        if (img !== first) photoEngine.setTexture(img);
      })
      .catch(() => undefined); // thumbnail stays — worse, but alive

    // Mouth upgrade, progressive as well. Any failure — bundle, template,
    // the avatar's own teeth photo — leaves the classic mouth, which always
    // works.
    if (info.mouth?.renderer === "continuous") {
      // The config goes through whole: an avatar with its own performance
      // kit names its manifest in `motion_url`, and the bundled Reference
      // motion below is what every other avatar plays (and the fallback).
      // An avatar without a teeth photo of its own gets the standard teeth,
      // which the API serves beside that motion.
      const mouthConfig = info.mouth;
      void loadScript(`${apiBase}/liveface-mouth.js`, () => !!window.__LivefaceMouth, "engine")
        .then(() =>
          window.__LivefaceMouth?.attach(photoEngine, mouthConfig, `${apiBase}/mouth-motion.json`)
        )
        .catch(() => undefined);
    }

    // Layered upgrade, also progressive: the avatar is already animating on
    // the flat photo; when the background/body/head decomposition lands the
    // engine flips render paths mid-flight. All-or-nothing — a body without
    // its head is worse than the flat photo.
    if (info.layer_urls) {
      const { background, body, head } = info.layer_urls;
      void Promise.all([
        background ? loadImage(background) : Promise.resolve(undefined),
        loadImage(body),
        loadImage(head),
      ])
        .then(([bg, bodyImg, headImg]) =>
          photoEngine.setLayers({ background: bg, body: bodyImg, head: headImg })
        )
        .catch(() => undefined);
    }
  }

  const synth = async (text: string): Promise<SynthesisPayload> => {
    const response = await fetch(`${apiBase}/embed/v1/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, provider, voice, locale }),
    });
    if (!response.ok) throw new Error(`synthesize failed: ${response.status}`);
    return response.json();
  };
  const queue = new SpeechQueue(engine, synth);
  // data-provider="browser": free local speechSynthesis voices.
  const useBrowserVoice = provider === "browser" && BrowserTTS.supported();
  // The browser voice gets its timing from the same phoneme-duration model
  // the server providers use — no audio is synthesised, only the cue track.
  const fetchCues = async (text: string) => {
    const response = await fetch(`${apiBase}/embed/v1/cues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, locale }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return { cues: data.cues, durationMs: data.duration_ms, wordMarks: data.word_marks };
  };
  const browserTts = useBrowserVoice
    ? new BrowserTTS(engine, fetchCues)
    : null;

  window.Liveface = {
    speak: (text: string) =>
      browserTts ? browserTts.speak(text, voice || undefined, locale) : queue.speak(text),
    stop: () => {
      queue.stop();
      browserTts?.stop();
    },
    isSpeaking: () => (browserTts ? browserTts.isSpeaking() : queue.isSpeaking()),
    listen: (options?: ListenOptions) => listen(options),
    sttSupported,
    tune: (partial: Partial<EngineTuning>) => {
      Object.assign(engine.tuning, partial);
    },
    engine,
  };
  canvas.setAttribute("data-liveface-state", "ready");
  canvas.dispatchEvent(new CustomEvent("liveface:ready", { bubbles: true }));
}

const current = document.currentScript as HTMLScriptElement | null;
if (current?.dataset.avatar) {
  // bootstrap shows its own failures; this only guards against a bug there.
  void bootstrap(current).catch((err) => console.error("[liveface]", err));
}

export { AvatarEngine, SpeechQueue, listen, sttSupported };
