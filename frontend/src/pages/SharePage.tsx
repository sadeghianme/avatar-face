import { AvatarEngine, BrowserTTS, type Rig } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";

import { Icon } from "../components/Icon";
import { Spinner } from "../components/Spinner";

interface PublicAvatar {
  name: string;
  kind: string;
  framing: string;
  rig_url: string;
  image_url: string;
  thumbnail_url: string;
  layer_urls?: Record<string, string> | null;
}

/**
 * The page behind a share link: one avatar, full screen, and a box to type in.
 *
 * Deliberately not the dashboard with the chrome hidden. A visitor arrives
 * with no account and one question — what does this thing do — so the whole
 * page is the answer: the face fills the screen and the only control is a
 * line to type and a button to press.
 *
 * Speech goes through the public endpoint, which is rate-limited and charges
 * the owner. Nothing here can address anything but this one avatar.
 */
export function SharePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  const [avatar, setAvatar] = useState<PublicAvatar | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held once: the engine reads canvas.width when it frames the face, so it
  // must not change under a mounted engine.
  const [dpr] = useState(() => Math.min(window.devicePixelRatio || 1, 3));

  useEffect(() => {
    let cancelled = false;
    let engine: AvatarEngine | null = null;

    const boot = async () => {
      const response = await fetch(`/api/public/v1/avatars/${token}`);
      if (!response.ok) throw new Error("unavailable");
      const info = (await response.json()) as PublicAvatar;
      if (cancelled) return;
      setAvatar(info);

      const [rigResponse, texture] = await Promise.all([
        fetch(info.rig_url),
        loadImage(info.image_url || info.thumbnail_url),
      ]);
      const rig = (await rigResponse.json()) as Rig;
      if (cancelled || !canvasRef.current) return;
      engine = new AvatarEngine(canvasRef.current, rig, texture, {
        fullPhoto: info.framing === "full",
      });
      engineRef.current = engine;

      const layers = info.layer_urls;
      if (layers?.body && layers.head) {
        const held = engine;
        void Promise.all([
          layers.background ? loadImage(layers.background) : Promise.resolve(undefined),
          loadImage(layers.body),
          loadImage(layers.head),
        ])
          .then(([background, body, head]) => {
            if (!cancelled) held.setLayers({ background, body, head });
          })
          .catch(() => undefined);
      }
    };

    boot().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      engineRef.current = null;
      engine?.destroy();
    };
  }, [token]);

  /**
   * Speak with the server voice, falling back to the visitor's own.
   *
   * The server voice is the point of a share link: it sounds identical for
   * everyone who opens it, where device voices differ by OS so the same
   * link would sound like a different character on every machine. Kokoro
   * runs on our own CPU, so this costs the owner no per-character fee —
   * only their monthly character allowance, and the speech cache means a
   * phrase asked twice is synthesized once.
   *
   * If the instance has no server voice, or the request is throttled, the
   * visitor's browser voice takes over rather than the page going silent.
   */
  const speak = async () => {
    const spoken = text.trim();
    if (!spoken || speaking || !engineRef.current) return;
    setSpeaking(true);
    setError(null);
    try {
      const served = await fetch(`/api/public/v1/avatars/${token}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: spoken,
          provider: "kokoro",
          voice: "af_heart",
          locale: "en-US",
        }),
      });
      if (served.ok) {
        const payload = await served.json();
        await new Promise<void>((resolve) => {
          engineRef.current!.playAudio(
            payload.audio_b64,
            payload.audio_mime,
            payload.cues,
            resolve
          );
        });
        return;
      }

      // No server voice on this instance, or throttled: speak locally rather
      // than leave the visitor looking at a silent face.
      if (!BrowserTTS.supported()) throw new Error(t("shareNoVoice"));
      const tts = new BrowserTTS(engineRef.current, async (phrase) => {
        const response = await fetch("/api/embed/v1/cues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: phrase, locale: "en-US" }),
        });
        if (!response.ok) return null;
        const body = await response.json();
        return { cues: body.cues, durationMs: body.duration_ms, wordMarks: body.word_marks };
      });
      await tts.speak(spoken, undefined, "en-US");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
    } finally {
      setSpeaking(false);
    }
  };

  if (failed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 px-6 text-center">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">{t("shareGoneTitle")}</h1>
          <p className="mt-2 text-sm text-gray-400">{t("shareGoneBody")}</p>
        </div>
      </div>
    );
  }

  return (
    /* Fixed viewport height, not min-height: with min-h-screen the column can
       grow past the viewport, `flex-1` never bounds the middle row, and the
       canvas pushes the composer off the bottom of the screen. dvh so mobile
       browser chrome does not hide the input. */
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-gray-950">
      <header className="px-5 py-4">
        <h1 className="text-sm font-medium text-gray-300">{avatar?.name ?? ""}</h1>
      </header>

      {/* The face takes whatever room is left over: min-h-0 lets this flex
          child actually shrink, without which the canvas pushes the composer
          off the bottom of a short window. */}
      <main className="flex min-h-0 flex-1 items-center justify-center px-4">
        {!avatar && <Spinner className="h-8 w-8 text-gray-600" />}
        <canvas
          ref={canvasRef}
          width={Math.round(720 * dpr)}
          height={Math.round(720 * dpr)}
          style={{ display: avatar ? "block" : "none" }}
          // object-contain letterboxes the square backing store into whatever
          // shape the leftover space happens to be.
          className="h-full w-full rounded-2xl object-contain"
        />
      </main>

      <footer className="px-4 pb-6 pt-3">
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter speaks, Shift+Enter is a newline — the convention every
              // message box already taught everyone.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void speak();
              }
            }}
            rows={1}
            maxLength={600}
            placeholder={t("sharePlaceholder")}
            className="input min-h-[46px] resize-none bg-gray-900 text-gray-100 placeholder-gray-500"
          />
          <button
            className="btn-primary h-[46px] shrink-0 px-5"
            onClick={() => void speak()}
            disabled={speaking || !text.trim() || !avatar}
          >
            {speaking ? <Spinner className="h-4 w-4" /> : <Icon name="speaker" className="h-4 w-4" />}
            {t("sharePlay")}
          </button>
        </div>
        {error && <p className="mx-auto mt-2 max-w-2xl text-xs text-red-400">{error}</p>}
        <p className="mx-auto mt-3 max-w-2xl text-center text-[11px] text-gray-600">
          {t("sharePoweredBy")}
        </p>
      </footer>
    </div>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = url;
  });
}
