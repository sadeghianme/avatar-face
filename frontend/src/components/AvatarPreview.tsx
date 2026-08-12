import { AvatarEngine, type Rig } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";

/**
 * Canvas preview that reuses the embed engine. StrictMode-safe: the engine's
 * `destroyed` flag plus this effect's cleanup handle mount->unmount->mount.
 */
export function AvatarPreview({
  rigUrl,
  textureUrl,
  size = 480,
  debugMesh = false,
  fullPhoto = false,
  onEngine,
}: {
  rigUrl: string;
  textureUrl: string;
  size?: number;
  debugMesh?: boolean;
  fullPhoto?: boolean;
  onEngine?: (engine: AvatarEngine | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Read once and held: the engine reads canvas.width in computeFraming, so
  // this must not change under a mounted engine.
  const [dpr] = useState(() => Math.min(window.devicePixelRatio || 1, 2));

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
      engine = new AvatarEngine(canvasRef.current, rig, texture, { debugMesh, fullPhoto });
      // Lets tooling drive poses (gaze, head) for visual checks; harmless in
      // production, and this file's tsconfig lacks vite/client types for a
      // clean import.meta.env.DEV gate.
      (window as unknown as Record<string, unknown>).__lfEngine = engine;
      onEngine?.(engine);
    };
    boot().catch((err: Error) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
      onEngine?.(null);
      engine?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigUrl, textureUrl, debugMesh, fullPhoto]);

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
      className="mx-auto rounded-xl bg-gray-100 dark:bg-gray-700"
    />
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load texture`));
    img.src = url;
  });
}
