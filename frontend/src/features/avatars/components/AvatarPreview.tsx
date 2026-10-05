import { AvatarEngine, type Rig, type Scene } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";
import { loadImage } from "@/lib/image";

/**
 * Canvas preview that reuses the embed engine. StrictMode-safe: the engine's
 * `destroyed` flag plus this effect's cleanup handle mount->unmount->mount.
 *
 * The engine draws the whole picture through its viewport, so the canvas
 * is a plain square: the "face" framing fills it like a profile picture and
 * the "full" framing shows the whole picture inside it. (A soft frame used
 * to fade the bottom of the canvas away, because the face framing cut the
 * shoulders in a straight line under the chin; it no longer does.)
 *
 * `scene` (zoom, pan, background) is applied live: changing it moves the
 * running engine's viewport without rebuilding it, which is what the
 * framing editor's drag and slider need.
 */
export function AvatarPreview({
  rigUrl,
  textureUrl,
  layerUrls,
  size = 480,
  debugMesh = false,
  fullPhoto = false,
  scene,
  soft = false,
  onEngine,
}: {
  rigUrl: string;
  textureUrl: string;
  /** Background/body/head decomposition; enables the layered render path. */
  layerUrls?: Record<string, string> | null;
  size?: number;
  debugMesh?: boolean;
  fullPhoto?: boolean;
  /** The scene to show; its zoom wins over `fullPhoto`. */
  scene?: Scene | null;
  /** The dashboard's framing: transparent over the page's backdrop, so a
   *  cut-out's own outline is its edge, instead of a grey card. */
  soft?: boolean;
  onEngine?: (engine: AvatarEngine | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AvatarEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read once and held: the engine reads canvas.width in computeFraming, so
  // this must not change under a mounted engine.
  const [dpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2));
  // The scene the engine starts with; later ones are applied live below.
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    let engine: AvatarEngine | null = null;
    let cancelled = false;

    const boot = async () => {
      const [rigResponse, texture] = await Promise.all([
        fetch(rigUrl),
        loadImage(textureUrl),
      ]);
      if (!rigResponse.ok) throw new Error(`rig fetch: ${rigResponse.status}`);
      const rig = (await rigResponse.json()) as Rig;
      if (cancelled || !canvasRef.current) return;
      engine = new AvatarEngine(canvasRef.current, rig, texture, { debugMesh, fullPhoto, scene: sceneRef.current });
      engineRef.current = engine;
      // Lets tooling drive poses (gaze, head) for visual checks; harmless in
      // production, and this file's tsconfig lacks vite/client types for a
      // clean import.meta.env.DEV gate.
      (window as unknown as Record<string, unknown>).__lfEngine = engine;
      onEngine?.(engine);


      if (layerUrls?.body && layerUrls.head) {
        const held = engine;
        void Promise.all([
          layerUrls.background ? loadImage(layerUrls.background) : Promise.resolve(undefined),
          loadImage(layerUrls.body),
          loadImage(layerUrls.head),
        ])
          .then(([bg, body, head]) => {
            if (!cancelled) held.setLayers({ background: bg, body, head });
          })
          .catch(() => undefined); // flat photo stays — still a working preview
      }
    };
    boot().catch((err: Error) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
      onEngine?.(null);
      engineRef.current = null;
      engine?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigUrl, textureUrl, debugMesh, fullPhoto, layerUrls]);

  // A changed scene moves the running engine; by value, so a parent that
  // builds the object each render does not move it for nothing.
  const sceneKey = JSON.stringify(scene ?? null);
  useEffect(() => {
    engineRef.current?.setScene(sceneRef.current);
  }, [sceneKey]);

  if (error) return <p className="field-error">{error}</p>;
  return (
    <canvas
      ref={canvasRef}
      // Backing store in DEVICE pixels, laid out at `size` CSS pixels. Without
      // this the mouth detail is drawn into a third of the pixels it was tuned
      // for — a single tooth is only a few pixels wide at the default size.
      width={Math.round(size * dpr)}
      height={Math.round(size * dpr)}
      // Fill the container: `size` is the backing-store resolution, not the
      // layout width, so the avatar uses the whole card instead of a 480px
      // island in the middle of it.
      style={{ width: "100%", height: "auto" }}
      className={`mx-auto rounded-xl ${soft ? "" : "bg-gray-100 dark:bg-gray-700"}`}
    />
  );
}

