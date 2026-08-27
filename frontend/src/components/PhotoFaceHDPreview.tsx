import type { CuePlayer, SpeechPlayer } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Avatar } from "../lib/types";

type HDEngine = SpeechPlayer & CuePlayer & { destroy(): void };

export function PhotoFaceHDPreview({
  avatar,
  onEngine,
}: {
  avatar: Avatar;
  onEngine?: (engine: HDEngine | null) => void;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const backgroundUrl = avatar.layer_urls?.background;
  const bodyUrl = avatar.layer_urls?.body;
  const headUrl = avatar.layer_urls?.head;

  useEffect(() => {
    let engine: HDEngine | null = null;
    let cancelled = false;

    const boot = async () => {
      if (!avatar.rig_url || !avatar.image_url || !canvasRef.current) return;
      setLoading(true);
      setError(null);
      const { PhotoFaceHDEngine } = await import("@liveface/embed/photoface-hd");
      const instance = await PhotoFaceHDEngine.load(canvasRef.current, {
        rigUrl: avatar.rig_url,
        imageUrl: avatar.image_url,
        layerUrls: {
          background: backgroundUrl,
          body: bodyUrl,
          head: headUrl,
        },
      });
      if (cancelled) {
        instance.destroy();
        return;
      }
      engine = instance;
      setLoading(false);
      onEngine?.(instance);
    };

    void boot().catch((reason: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : t("photofaceHDError"));
    });

    return () => {
      cancelled = true;
      onEngine?.(null);
      engine?.destroy();
    };
  }, [avatar.id, avatar.image_url, avatar.rig_url, backgroundUrl, bodyUrl, headUrl, onEngine, t]);

  return (
    <div className="relative aspect-square overflow-hidden rounded-2xl bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.16),transparent_58%),linear-gradient(to_bottom,#f8fafc,#e2e8f0)] dark:bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.18),transparent_58%),linear-gradient(to_bottom,#262626,#111827)]">
      <canvas
        ref={canvasRef}
        width={640}
        height={640}
        aria-label={`${avatar.name} Photoface HD preview`}
        className="h-full w-full"
      />
      {loading ? (
        <div
          aria-live="polite"
          className="absolute inset-0 grid place-items-center bg-white/45 text-sm text-gray-500 backdrop-blur-sm dark:bg-black/25 dark:text-gray-300"
        >
          {t("photofaceHDLoading")}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="absolute inset-x-5 bottom-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
