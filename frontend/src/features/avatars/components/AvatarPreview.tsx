import { AvatarEngine, type Rig } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";
import { loadImage } from "@/lib/image";

/** The aspect (w/h) of the face crop the engine frames (AvatarEngine.
 * computeFraming: the face box widened by a quarter each side, a little
 * more than half its height above, and under a fifth below the chin). */
function cropAspect(rig: Rig): number {
  const [bx0, by0, bx1, by1] = rig.face_box;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const [iw, ih] = rig.image_size;
  const x0 = Math.max(0, bx0 - bw * 0.25);
  const y0 = Math.max(0, by0 - bh * 0.55);
  const w = Math.min(iw, bx1 + bw * 0.25) - x0;
  const h = Math.min(ih, by1 + bh * 0.18) - y0;
  return w > 0 && h > 0 ? w / h : 1;
}

// The soft frame: the crop ends at the chin, which cuts the shoulders
// straight; the bottom (and, lightly, the sides) dissolve into whatever is
// behind instead of ending in an edge.
const SOFT_MASK =
  "linear-gradient(to bottom, #000 0, #000 84%, transparent 100%), linear-gradient(to right, transparent 0, #000 4%, #000 96%, transparent 100%)";
const MIN_SOFT_ASPECT = 0.8;

/**
 * Canvas preview that reuses the embed engine. StrictMode-safe: the engine's
 * `destroyed` flag plus this effect's cleanup handle mount->unmount->mount.
 */
export function AvatarPreview({
  rigUrl,
  textureUrl,
  layerUrls,
  size = 480,
  debugMesh = false,
  fullPhoto = false,
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
  /** The dashboard's framing: the canvas takes the crop's own shape (not a
   * square with bands beside it), is transparent over the page's backdrop,
   * and fades out at the bottom edge. */
  soft?: boolean;
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
      if (soft && !fullPhoto) {
        // Before the engine reads the canvas: as tall as the crop is, within reason.
        const canvas = canvasRef.current;
        const aspect = Math.min(1, Math.max(MIN_SOFT_ASPECT, cropAspect(rig)));
        canvas.height = Math.round(canvas.width / aspect);
      }
      engine = new AvatarEngine(canvasRef.current, rig, texture, { debugMesh, fullPhoto });
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
      engine?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigUrl, textureUrl, debugMesh, fullPhoto, layerUrls, soft]);

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
      style={{
        width: "100%",
        height: "auto",
        ...(soft && !fullPhoto
          ? { maskImage: SOFT_MASK, WebkitMaskImage: SOFT_MASK, maskComposite: "intersect", WebkitMaskComposite: "source-in" }
          : {}),
      }}
      className={`mx-auto rounded-xl ${soft && !fullPhoto ? "" : "bg-gray-100 dark:bg-gray-700"}`}
    />
  );
}

