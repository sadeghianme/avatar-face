import type { SpeechPlayer } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";

import { FieldError } from "@/components/ui/FieldError";
import { cx } from "@/lib/cx";

/**
 * 3D GLB avatar preview. The Three.js engine is dynamically imported so
 * the main dashboard bundle stays slim — only avatars with kind=model3d
 * pay the ~600KB cost.
 */
export function Avatar3DPreview({
  modelUrl,
  size = 480,
  fit = "width",
  onEngine,
}: {
  modelUrl: string;
  size?: number;
  /** As AvatarPreview's: as wide as the container, or filling a box. */
  fit?: "width" | "box";
  onEngine?: (engine: SpeechPlayer | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The latest callback: a parent's inline one must not reload the model.
  const onEngineRef = useRef(onEngine);
  onEngineRef.current = onEngine;

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
      onEngineRef.current?.(instance);
    };
    boot().catch((err: Error) => {
      if (!cancelled) {
        setLoading(false);
        setError(err.message);
      }
    });

    return () => {
      cancelled = true;
      onEngineRef.current?.(null);
      engine?.destroy();
    };
  }, [modelUrl]);

  if (error) return <FieldError>{error}</FieldError>;
  return (
    <div className={cx("relative", fit === "box" && "h-full w-full")}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">Loading 3D model…</div>
      )}
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className={cx(
          "mx-auto bg-gradient-to-b from-indigo-100 to-slate-200 dark:from-gray-700 dark:to-gray-800",
          fit === "box" ? "h-full w-full object-contain" : "max-w-full rounded-xl"
        )}
      />
    </div>
  );
}
