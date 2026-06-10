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
import { AvatarEngine } from "./engine";
import { SpeechQueue } from "./speech";
import { listen, sttSupported, ListenOptions } from "./stt";
import { Rig, SynthesisPayload } from "./types";

interface LivefaceApi {
  speak(text: string): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
  listen(options?: ListenOptions): Promise<string>;
  sttSupported(): boolean;
  engine: AvatarEngine | null;
}

declare global {
  interface Window {
    Liveface?: LivefaceApi;
  }
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
  const info: { rig_url: string; thumbnail_url: string } = await meta.json();

  const [rigResponse, texture] = await Promise.all([
    fetch(info.rig_url),
    loadImage(info.thumbnail_url),
  ]);
  const rig: Rig = await rigResponse.json();

  const engine = new AvatarEngine(canvas, rig, texture);

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

  window.Liveface = {
    speak: (text: string) => queue.speak(text),
    stop: () => queue.stop(),
    isSpeaking: () => queue.isSpeaking(),
    listen: (options?: ListenOptions) => listen(options),
    sttSupported,
    engine,
  };
  canvas.dispatchEvent(new CustomEvent("liveface:ready", { bubbles: true }));
}

const current = document.currentScript as HTMLScriptElement | null;
if (current?.dataset.avatar) {
  void bootstrap(current).catch((err) => console.error("[liveface]", err));
}

export { AvatarEngine, SpeechQueue, listen, sttSupported };
