/**
 * liveface.js — auto-bootstrapping embed widget.
 *
 *   <script src="https://api.example.com/liveface.js"
 *           data-avatar="AVATAR_ID"
 *           data-key="lf_..."
 *           data-api="https://api.example.com"
 *           data-voice="offline-warm"
 *           data-provider="offline"></script>
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
  // Default to the visitor's free system voices when the browser has them.
  const provider =
    script.dataset.provider ?? (BrowserTTS.supported() ? "browser" : "offline");
  const voice = script.dataset.voice ?? (provider === "browser" ? "" : "offline-warm");
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

  // Reserve the space and show something immediately.
  //
  // Between the script running and the first frame there are three network
  // round trips — the avatar record, the rig, and a photograph that can be a
  // couple of megabytes. On a customer's page that was several seconds of
  // nothing at all, followed by the layout jumping as the canvas appeared.
  // The placeholder holds the exact final size, so nothing moves when the
  // avatar arrives.
  const mount = document.createElement("div");
  mount.style.cssText = `position:relative;display:inline-block;width:${size}px;max-width:100%`;
  const placeholder = document.createElement("div");
  placeholder.setAttribute("data-liveface-loading", "");
  placeholder.style.cssText =
    "position:absolute;inset:0;border-radius:12px;" +
    // A moving sheen rather than a spinner: it reads as "this is arriving"
    // instead of "something is wrong", and it needs no icon or wordmark that
    // would clash with whatever the host page looks like.
    "background:linear-gradient(100deg,rgba(128,128,128,0.10) 30%,rgba(128,128,128,0.20) 50%,rgba(128,128,128,0.10) 70%);" +
    "background-size:220% 100%;animation:liveface-sheen 1.4s ease-in-out infinite;";
  if (!document.getElementById("liveface-style")) {
    const style = document.createElement("style");
    style.id = "liveface-style";
    // Scoped to our own keyframe name so it cannot collide with the host's.
    style.textContent =
      "@keyframes liveface-sheen{0%{background-position:180% 0}100%{background-position:-80% 0}}" +
      "@media (prefers-reduced-motion:reduce){[data-liveface-loading]{animation:none!important}}";
    document.head.appendChild(style);
  }
  mount.appendChild(canvas);
  mount.appendChild(placeholder);
  script.insertAdjacentElement("afterend", mount);

  /** Called once there is a real frame to look at. */
  const ready = () => placeholder.remove();

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
  } = await meta.json();

  let engine: SpeechPlayer & { isSpeaking(): boolean };
  if (info.kind === "model3d" && info.model_url) {
    // 3D avatar: lazy-load the Three.js bundle, then hand it the GLB.
    await loadScript(`${apiBase}/liveface-3d.js`);
    if (!window.__Liveface3D) throw new Error("liveface-3d.js failed to initialize");
    engine = await window.__Liveface3D.load(canvas, info.model_url);
    ready();
  } else {
    const rig: Rig = await (await fetch(info.rig_url)).json();
    const fullUrl = info.image_url || info.thumbnail_url;

    // Start on the thumbnail, upgrade to the photograph.
    //
    // The full-resolution image is the one that must end up on screen — a
    // 256px thumbnail stretched across a canvas backing store 2-3x the CSS
    // size is what made embedded avatars look soft. But it is also the one
    // thing here big enough to keep the page empty for seconds. Loading the
    // small one first puts a talking face on the page almost immediately and
    // then sharpens it in place, which beats both a slow blank box and a
    // permanently soft avatar.
    const firstUrl = info.thumbnail_url || fullUrl;
    const texture = await loadImage(firstUrl);
    const avatar = new AvatarEngine(canvas, rig, texture, {
      // data-framing on the snippet wins; otherwise the avatar's own setting,
      // so changing it in the dashboard reaches sites already embedding it.
      fullPhoto: (script.dataset.framing ?? info.framing) === "full",
    });
    engine = avatar;
    ready();

    if (fullUrl && fullUrl !== firstUrl) {
      // Deliberately not awaited: the avatar is already animating, and a slow
      // photograph must not hold up speech. A failure here leaves the
      // thumbnail in place, which is a soft avatar rather than a broken one.
      loadImage(fullUrl)
        .then((sharp) => avatar.setTexture(sharp))
        .catch((error) => console.warn("[liveface] full-resolution image failed:", error));
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
