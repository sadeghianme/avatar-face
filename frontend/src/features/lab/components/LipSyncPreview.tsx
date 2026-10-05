import { AvatarEngine, type Rig } from "@liveface/embed";
import type { MouthExtension, MouthPose } from "@liveface/embed/mouth-extension";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadImage } from "@/lib/image";
import type { Avatar } from "@/lib/types";

/** Reuse the stable renderer with an opt-in audio clock. Existing previews
 * and avatar assets are not modified by this experiment. */
export function LipSyncPreview({ avatar, clock, onEngine, mouthExtension, pose, still = false, mouthOnly = false }: {
  avatar: Avatar;
  clock?: () => number;
  onEngine: (engine: AvatarEngine | null) => void;
  mouthExtension?: MouthExtension;
  pose?: () => MouthPose | null;
  still?: boolean;
  mouthOnly?: boolean;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState({ x: 0.5, y: 0.6, zoom: 3 });
  const [resolution] = useState(() => Math.round(480 * Math.min(devicePixelRatio || 1, 2)));
  const { rig_url: rigUrl, image_url: imageUrl, framing } = avatar;
  const background = avatar.layer_urls?.background;
  const body = avatar.layer_urls?.body;
  const head = avatar.layer_urls?.head;

  useEffect(() => {
    let cancelled = false;
    let engine: AvatarEngine | null = null;
    setError(false);
    setLoading(true);
    const boot = async () => {
      if (!rigUrl || !imageUrl) throw new Error("Missing avatar assets");
      const [response, image] = await Promise.all([fetch(rigUrl), loadImage(imageUrl)]);
      if (!response.ok) throw new Error("Could not load face rig");
      const rig = await response.json() as Rig;
      if (cancelled || !canvas.current) return;
      engine = new AvatarEngine(canvas.current, rig, image, { fullPhoto: framing === "full", cueClock: clock, mouthExtension, pose });
      // Where the mouth landed on the canvas, from the engine's own
      // viewport, for the CSS zoom of the mouth-only view: zooming the
      // already rendered canvas never restarts speech.
      const lips = rig.outer_lip_ring.map(i => engine!.landmarks()[i]).filter(Boolean);
      if (lips.length) {
        const minX = Math.min(...lips.map(p => p.x)), maxX = Math.max(...lips.map(p => p.x));
        const cy = lips.reduce((sum, p) => sum + p.y, 0) / lips.length;
        setFocus({ x: (minX + maxX) / 2 / resolution, y: cy / resolution,
          zoom: Math.min(5, Math.max(1, resolution * 0.6 / Math.max(1, maxX - minX))) });
      }
      // Remove random head motion from the comparison: judge the mouth.
      engine.tuning.headMotion = 0;
      if (still) { engine.tuning.bodyMotion = 0; engine.tuning.blink = 0; }
      if (body && head) {
        const layers = await Promise.all([
          background ? loadImage(background) : undefined, loadImage(body), loadImage(head),
        ]).catch(() => null);
        if (!cancelled && layers) engine.setLayers({ background: layers[0], body: layers[1], head: layers[2] });
      }
      if (cancelled) return;
      setLoading(false);
      onEngine(engine);
    };
    void boot().catch(() => {
      if (!cancelled) { setError(true); setLoading(false); }
    });
    return () => { cancelled = true; onEngine(null); engine?.destroy(); };
  }, [rigUrl, imageUrl, framing, background, body, head, clock, onEngine, mouthExtension, pose, still]);

  return <div className="relative aspect-square overflow-hidden rounded-xl bg-gray-100 dark:bg-gray-800">
    <canvas ref={canvas} width={resolution} height={resolution} className="h-full w-full" aria-label={avatar.name}
      data-focus-x={focus.x} data-focus-y={focus.y} data-focus-zoom={focus.zoom}
      style={mouthOnly ? { transformOrigin: "0 0", transform: `translate(50%, 50%) scale(${focus.zoom}) translate(${-focus.x * 100}%, ${-focus.y * 100}%)` } : undefined} />
    {loading && <p role="status" className="absolute inset-0 grid place-items-center bg-white/70 text-sm dark:bg-black/70">{t("loading")}</p>}
    {error && <p role="alert" className="absolute inset-0 grid place-items-center bg-white/80 p-4 text-center text-sm text-red-600 dark:bg-black/80">{t("lipSyncPreviewError")}</p>}
  </div>;
}
