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
  const provider = script.dataset.provider ?? "offline";
  const voice = script.dataset.voice ?? "offline-warm";
  const locale = script.dataset.locale ?? "en-US";
  const size = Number(script.dataset.size ?? 320);
  if (!avatarId || !apiKey) {
    console.error("[liveface] missing data-avatar or data-key");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
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
    rig_url: string;
    thumbnail_url: string;
    model_url?: string | null;
  } = await meta.json();

  let engine: SpeechPlayer & { isSpeaking(): boolean };
  if (info.kind === "model3d" && info.model_url) {
    // 3D avatar: lazy-load the Three.js bundle, then hand it the GLB.
    await loadScript(`${apiBase}/liveface-3d.js`);
    if (!window.__Liveface3D) throw new Error("liveface-3d.js failed to initialize");
    engine = await window.__Liveface3D.load(canvas, info.model_url);
  } else {
    const [rigResponse, texture] = await Promise.all([
      fetch(info.rig_url),
      loadImage(info.thumbnail_url),
    ]);
    const rig: Rig = await rigResponse.json();
    engine = new AvatarEngine(canvas, rig, texture);
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
  const browserTts = useBrowserVoice ? new BrowserTTS(engine as unknown as CuePlayer) : null;

  window.Liveface = {
    speak: (text: string) =>
      browserTts ? browserTts.speak(text, voice === "offline-warm" ? undefined : voice, locale) : queue.speak(text),
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
