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
 *   Liveface.speak(text)  — chunked + prefetched for long text; rejects
 *                           with a SpeechError (`code`, `detail`, `status`)
 *                           when the server refuses a line
 *   Liveface.stop()
 *   Liveface.isSpeaking()
 *   Liveface.listen({lang}) — browser STT, resolves with the transcript
 *   Liveface.sttSupported()
 *   Liveface.tune({...}), Liveface.engine
 *   Liveface.express(name, intensity?, timing?) — an expression ("happy",
 *                           "surprised", "concerned", "thinking", "serious";
 *                           "neutral" releases), docs/emotions.md
 *
 * With several widgets on a page, those act on the FIRST to come up (on a
 * page with one, that one), and each widget has its own handle with the
 * same calls: Liveface.get(avatarId or its canvas or script tag),
 * Liveface.all(), and `event.detail` of its `liveface:ready` (widget/handles.ts).
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
 *
 * Tags in the text said, `[happy]`, `[surprised:0.6]`, set expressions in
 * time with the voice and are never read aloud (on by default). Both of the
 * rest are opt-in: data-expressions="auto" also guesses them for a text
 * without tags and adds idle micro-expressions; data-idle-expressions="on"
 * adds the idle ones alone ("off" keeps them off even with "auto");
 * data-expressions="off" ignores tags (still stripped).
 *
 * data-head-motion="2d" or "3d" chooses how the head moves (engine.ts
 * EngineOptions.headMotion); without it, the avatar's own default, by its
 * published face type: the turn in depth for a person, the rigid layer for
 * an animal or a cartoon.
 */
import type { CueResponse, EmbedAvatarOut, SynthesizeResponse } from "./api-types";
import { BrowserTTS } from "./browser-tts";
import { aiLabel, renderAiLabel } from "./widget/disclosure";
import { AvatarEngine, type HeadMotionMode } from "./engine";
import type { Avatar3DEngine, Avatar3DOptions } from "./engine3d";
import { expressionNamed } from "./engine/expression-table";
import { expressionMode } from "./expression-markup";
import { SpeechQueue } from "./speech";
import { speechErrorOfResponse } from "./speech-error";
import { listen, sttSupported, ListenOptions } from "./stt";
import type { AvatarMouthConfig } from "./mouth";
import { EngineTuning, Rig } from "./types";
import { showFailure } from "./widget/failure";
import { asFailure, fetchJson, loadImage, loadScript } from "./widget/load";
import { addWidget, announce, livefacePage, type LivefaceHandle, type LivefacePage } from "./widget/handles";

declare global {
  interface Window {
    Liveface?: LivefacePage;
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

/** A data-* switch: present and not "off", "false" or "0". */
function switchedOn(value: string | undefined): boolean {
  return value !== undefined && !["off", "false", "0"].includes(value.trim().toLowerCase());
}

/** data-head-motion: "2d" or "3d"; anything else leaves the avatar's own. */
function headMotionAttr(value: string | undefined): HeadMotionMode | undefined {
  const v = value?.trim().toLowerCase();
  return v === "2d" || v === "3d" ? v : undefined;
}

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
    const failure = asFailure(error, "engine");
    showFailure(canvas, failure, locale);
    script.dispatchEvent(
      new CustomEvent("liveface:error", { detail: { stage: failure.stage, message: failure.message } })
    );
    // A page that calls Liveface.speak() gets a quiet answer, not a
    // TypeError; another widget's working API is left in place.
    livefacePage();
  }
}

/** Everything after the canvas is in place: the avatar fetched and drawn,
 *  its handle on the page (widget/handles.ts). Throws (a WidgetFailure,
 *  mostly) when it cannot. */
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
  // How a text's expressions are read: tags (the default), auto, off.
  const expressions = expressionMode(script.dataset.expressions);

  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };
  // The published avatar (backend schemas.published, EmbedAvatarOut): its
  // type is generated from the API's schema (api-types.ts).
  const info = await fetchJson<EmbedAvatarOut>(`${apiBase}/embed/v1/avatars/${avatarId}`, "avatar", {
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
      fullPromise ? Promise.race([thumbPromise, fullPromise]).catch(() => thumbPromise) : thumbPromise,
    ]);
    // The zoom: data-zoom on the snippet wins, then data-framing (face is
    // 1, full 0), then the avatar's published scene, then its framing — so
    // what the owner sets in the dashboard reaches sites already embedding
    // it, and a site that says otherwise keeps its say. The scene's pan
    // and background come with it either way.
    const zoomAttr = Number(script.dataset.zoom);
    const framingAttr = script.dataset.framing;
    const zoom =
      script.dataset.zoom !== undefined && Number.isFinite(zoomAttr)
        ? zoomAttr
        : framingAttr
          ? framingAttr === "full"
            ? 0
            : 1
          : undefined;
    const photoEngine = new AvatarEngine(canvas, rig, first, {
      fullPhoto: info.framing === "full",
      scene: info.scene ?? undefined,
      zoom,
      // data-warp="2d" keeps the mesh on the Canvas 2D path (engine/warp-gl.ts):
      // for a site that must not use WebGL, and for comparing the two.
      warp: script.dataset.warp === "2d" ? "2d" : undefined,
      // data-head-motion wins; else the published face type's (a person's
      // turns in depth, an animal's or a cartoon's moves as a layer).
      headMotion: headMotionAttr(script.dataset.headMotion),
      faceType: info.face_type,
      // Off unless asked for: by data-idle-expressions, or with the
      // automatic mode.
      idleExpressions:
        script.dataset.idleExpressions !== undefined
          ? switchedOn(script.dataset.idleExpressions)
          : expressions === "auto",
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
        .then(() => window.__LivefaceMouth?.attach(photoEngine, mouthConfig, `${apiBase}/mouth-motion.json`))
        .catch(() => undefined);
    }

    // The AI expression pictures, when the owner chose them: progressive
    // too, the animated expressions play until they are in (and stay, should
    // they fail).
    if (info.expressions) {
      void photoEngine.setExpressionPictures({
        manifestUrl: info.expressions.manifest_url,
        imageUrls: info.expressions.image_urls,
      });
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
        .then(([bg, bodyImg, headImg]) => photoEngine.setLayers({ background: bg, body: bodyImg, head: headImg }))
        .catch(() => undefined);
    }
  }

  const synth = async (text: string, options?: { wordMarks?: boolean }): Promise<SynthesizeResponse> => {
    // Each word's start time only for a text with expressions to place.
    const marks = options?.wordMarks ? { word_marks: true } : {};
    const response = await fetch(`${apiBase}/embed/v1/synthesize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, provider, voice, locale, ...marks }),
    });
    // Liveface.speak() rejects with the API's reason (SpeechError: its
    // code, detail and status), so a page can branch on the code.
    if (!response.ok) throw await speechErrorOfResponse(response);
    return (await response.json()) as SynthesizeResponse;
  };
  const queue = new SpeechQueue(engine, synth, { expressions, locale });
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
    const data = (await response.json()) as CueResponse;
    return { cues: data.cues, durationMs: data.duration_ms, wordMarks: data.word_marks };
  };
  const browserTts = useBrowserVoice ? new BrowserTTS(engine, fetchCues, expressions) : null;

  const handle: LivefaceHandle = {
    avatar: avatarId,
    canvas,
    speak: (text: string) => (browserTts ? browserTts.speak(text, voice || undefined, locale) : queue.speak(text)),
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
    // The 3D engine has no expressions yet: a quiet no-op there.
    express: (name, intensity = 1, timing) => {
      const known = expressionNamed(name);
      if (known && engine instanceof AvatarEngine) engine.setExpression(known, intensity, timing);
    },
    engine,
  };
  addWidget(handle, script);
  canvas.setAttribute("data-liveface-state", "ready");
  announce(canvas, script, "liveface:ready", handle);
}

const current = document.currentScript as HTMLScriptElement | null;
if (current?.dataset.avatar) {
  // bootstrap shows its own failures; this only guards against a bug there.
  void bootstrap(current).catch((err) => console.error("[liveface]", err));
}

export { AvatarEngine, SpeechQueue, listen, sttSupported };
