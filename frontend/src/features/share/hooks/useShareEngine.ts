import { AvatarEngine, type Rig } from "@liveface/embed";
import { type RefObject, useEffect, useRef, useState } from "react";

import { useAvatarMouth } from "@/features/avatars";
import { fetchPublicAvatar, type PublicAvatar } from "@/features/share/api";
import { loadImage } from "@/lib/image";

/**
 * The share link's avatar on the page's canvas: the published avatar
 * fetched, its rig and picture loaded, the engine started on them (and its
 * layers and its published mouth once they arrive), and all of it stopped
 * when the page goes. `failed` once the link answers nothing (gone, never
 * was, or its files would not load).
 */
export function useShareEngine(token: string | undefined, canvasRef: RefObject<HTMLCanvasElement>) {
  const engineRef = useRef<AvatarEngine | null>(null);
  const [mouthEngine, setMouthEngine] = useState<AvatarEngine | null>(null);
  const [avatar, setAvatar] = useState<PublicAvatar | null>(null);
  const [failed, setFailed] = useState(false);
  // Held once: the engine reads canvas.width when it frames the face, so it
  // must not change under a mounted engine.
  const [dpr] = useState(() => Math.min(window.devicePixelRatio || 1, 3));

  useEffect(() => {
    let cancelled = false;
    let engine: AvatarEngine | null = null;

    const boot = async () => {
      const info = await fetchPublicAvatar(token);
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
        // The owner's published scene: the same zoom, pan and background
        // the widget and the dashboard show.
        scene: info.scene ?? undefined,
        // The published face type: a person's head turns in depth, an
        // animal's or a cartoon's moves as a layer, whatever its rig names.
        faceType: info.face_type,
        // `__liveface` for measuring a live share page (frame cadence, lip
        // gap); our own page, so the handle is opted into here.
        debug: true,
      });
      engineRef.current = engine;
      setMouthEngine(engine);

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
      setMouthEngine(null);
      engineRef.current = null;
      engine?.destroy();
    };
  }, [token, canvasRef]);

  useAvatarMouth(mouthEngine, avatar?.mouth ?? null);

  return { avatar, failed, engineRef, dpr };
}
