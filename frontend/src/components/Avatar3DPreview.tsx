import type { SpeechPlayer } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";

/**
 * 3D GLB avatar preview. The Three.js engine is dynamically imported so
 * the main dashboard bundle stays slim — only avatars with kind=model3d
 * pay the ~600KB cost.
 */
export function Avatar3DPreview({
  modelUrl,
  size = 480,
  onEngine,
}: {
  modelUrl: string;
  size?: number;
  onEngine?: (engine: SpeechPlayer | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let engine: { destroy(): void } | null = null;
    let cancelled = false;

    const boot = async () => {
      const { Avatar3DEngine } = await import("@liveface/embed/engine3d");
      if (cancelled || !canvasRef.current) return;
      const instance = await Avatar3DEngine.load(canvasRef.current, modelUrl);
      if (cancelled) {
        instance.destroy();
        return;
      }
      engine = instance;
      setLoading(false);
      onEngine?.(instance);
    };
    boot().catch((err: Error) => {
      if (!cancelled) {
        setLoading(false);
        setError(err.message);
      }
    });

    return () => {
      cancelled = true;
      onEngine?.(null);
      engine?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  if (error) return <p className="field-error">{error}</p>;
  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          Loading 3D model…
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="mx-auto max-w-full rounded-xl bg-gradient-to-b from-indigo-100 to-slate-200 dark:from-gray-700 dark:to-gray-800"
      />
    </div>
  );
}
