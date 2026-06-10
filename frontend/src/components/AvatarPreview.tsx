import { AvatarEngine, type Rig } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";

/**
 * Canvas preview that reuses the embed engine. StrictMode-safe: the engine's
 * `destroyed` flag plus this effect's cleanup handle mount->unmount->mount.
 */
export function AvatarPreview({
  rigUrl,
  textureUrl,
  size = 320,
  debugMesh = false,
  onEngine,
}: {
  rigUrl: string;
  textureUrl: string;
  size?: number;
  debugMesh?: boolean;
  onEngine?: (engine: AvatarEngine | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

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
      engine = new AvatarEngine(canvasRef.current, rig, texture, { debugMesh });
      onEngine?.(engine);
    };
    boot().catch((err: Error) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
      onEngine?.(null);
      engine?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigUrl, textureUrl, debugMesh]);

  if (error) return <p className="field-error">{error}</p>;
  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="mx-auto max-w-full rounded-xl bg-gray-100 dark:bg-gray-700"
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
