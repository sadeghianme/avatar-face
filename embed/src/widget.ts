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
 */
import { BrowserTTS, CuePlayer } from "./browser-tts";
import { AvatarEngine } from "./engine";
import type { Avatar3DEngine } from "./engine3d";
import { SpeechPlayer, SpeechQueue } from "./speech";
import { listen, sttSupported, ListenOptions } from "./stt";
import { EngineTuning, Rig, SynthesisPayload } from "./types";

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
      load: (canvas: HTMLCanvasElement, modelUrl: string) => Promise<Avatar3DEngine>;
    };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

async function bootstrap(script: HTMLScriptElement): Promise<void> {
  const avatarId = script.dataset.avatar;
  const apiKey = script.dataset.key;
  const apiBase = (script.dataset.api ?? new URL(script.src).origin).replace(/\/$/, "");
  // Default to the server voice: it sounds the same for every visitor,
  // where device voices differ by OS and browser. An explicit
  // data-provider always wins, and every snippet the dashboard generates
  // states one, so this only governs hand-written tags.
  const provider = script.dataset.provider ?? "kokoro";
  const voice =
    script.dataset.voice ??
    (provider === "kokoro" ? "af_heart" : provider === "browser" ? "" : "offline-warm");
  const locale = script.dataset.locale ?? "en-US";
  const size = Number(script.dataset.size ?? 320);
  if (!avatarId || !apiKey) {
    console.error("[liveface] missing data-avatar or data-key");
    return;
  }

  const canvas = document.createElement("canvas");
  // The backing store has to be in DEVICE pixels. CSS pixels are not what the
  // screen has, and at the default size of 320 that difference is the whole
  // ballgame: an individual tooth is ~4.5px wide, so the teeth, the lip-depth
  // bands and the corner fade were all being drawn into a few pixels and
  // averaged away. The 3D path has always done this (setPixelRatio); the 2D
  // path never did. Capped at 2x — past that the fill cost is real and the
  // gain is not visible.
  // Capped at 3 rather than 2 now that the texture is the full-resolution
  // photo — with a 256px thumbnail behind it, more backing store bought
  // nothing but a bigger upscale, so the old cap cost nothing. It does now.
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

  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
  const meta = await fetch(`${apiBase}/embed/v1/avatars/${avatarId}`, {
    headers: { "X-Api-Key": apiKey },
  });
  if (!meta.ok) {
    console.error("[liveface] avatar fetch failed:", await meta.text());
    return;
  }
  const info: {
    kind?: string;
    framing?: string;
    rig_url: string;
    thumbnail_url: string;
    image_url?: string | null;
    model_url?: string | null;
    layer_urls?: { background?: string; body: string; head: string } | null;
  } = await meta.json();

  let engine: SpeechPlayer & { isSpeaking(): boolean };
  if (info.kind === "model3d" && info.model_url) {
    // 3D avatar: lazy-load the Three.js bundle, then hand it the GLB.
    await loadScript(`${apiBase}/liveface-3d.js`);
    if (!window.__Liveface3D) throw new Error("liveface-3d.js failed to initialize");
    engine = await window.__Liveface3D.load(canvas, info.model_url);
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
    const [rigResponse, first] = await Promise.all([
      fetch(info.rig_url),
      fullPromise
        ? Promise.race([thumbPromise, fullPromise]).catch(() => thumbPromise)
        : thumbPromise,
    ]);
    const rig: Rig = await rigResponse.json();
    const photoEngine = new AvatarEngine(canvas, rig, first, {
      // data-framing on the snippet wins; otherwise the avatar's own setting,
      // so changing it in the dashboard reaches sites already embedding it.
      fullPhoto: (script.dataset.framing ?? info.framing) === "full",
    });
    engine = photoEngine;
    void fullPromise
      ?.then((img) => {
        if (img !== first) photoEngine.setTexture(img);
      })
      .catch(() => undefined); // thumbnail stays — worse, but alive


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
    ? new BrowserTTS(engine as unknown as CuePlayer, fetchCues)
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
      Object.assign((engine as unknown as { tuning: EngineTuning }).tuning, partial);
    },
    engine,
  };
  canvas.dispatchEvent(new CustomEvent("liveface:ready", { bubbles: true }));
}

const current = document.currentScript as HTMLScriptElement | null;
if (current?.dataset.avatar) {
  void bootstrap(current).catch((err) => console.error("[liveface]", err));
}

export { AvatarEngine, SpeechQueue, listen, sttSupported };
