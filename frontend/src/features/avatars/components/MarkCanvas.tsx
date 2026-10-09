import { MarkLoupe } from "@/features/avatars/components/mark/MarkLoupe";
import { MarkOutlines } from "@/features/avatars/components/mark/MarkOutlines";
import { type FaceMarks, GROUP_COLOURS } from "@/features/avatars/face-marks";
import { useMarkCanvas } from "@/features/avatars/hooks/useMarkCanvas";
import { cx } from "@/lib/cx";

/** A point's button: 24px around the dot, centred on the point; the
 *  canvas takes the pointer, the button takes the keyboard. */
const HANDLE = cx(
  "pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center",
  "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white"
);

/**
 * The photo with its marks: press near a handle and drag it, or Tab to one
 * and nudge it with the arrow keys.
 *
 * A zoom in the corner of the photo shows three times what is under the
 * pointer whenever one is over the photo — hovering, no click needed; on a
 * touch screen, while a finger is down — and, while a handle is dragged or
 * nudged, the photo around that handle. The point being placed is usually
 * smaller than the pointer placing it, and hidden under the finger.
 *
 * A press picks the NEAREST handle (face-marks `handleAt`), never the button
 * under the pointer: the handles are closer together than their buttons are
 * wide, and the button painted last would win every overlap. The buttons are
 * there for the keyboard and for screen readers only. The pointer, the keys
 * and the zoom's painting are useMarkCanvas's; the zoom is MarkLoupe.
 */
export function MarkCanvas({
  imageUrl,
  imageSize,
  marks,
  onChange,
}: {
  imageUrl: string;
  imageSize: [number, number];
  marks: FaceMarks;
  onChange: (marks: FaceMarks) => void;
}) {
  const canvas = useMarkCanvas({ imageSize, marks, onChange });
  const [imgW, imgH] = imageSize;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const dash = Math.max(imgW, imgH) / 90;

  return (
    <div
      ref={canvas.containerRef}
      className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-gray-100
        dark:bg-gray-700"
      style={{ aspectRatio: `${imgW} / ${imgH}` }}
      {...canvas.pointer}
    >
      <img src={imageUrl} alt="" className="h-full w-full object-fill" draggable={false} />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 ${imgW} ${imgH}`}
        preserveAspectRatio="none"
      >
        <MarkOutlines marks={marks} dash={dash} />
      </svg>

      {canvas.handles.map((h) => {
        const p = h.at(marks);
        const isActive = (canvas.dragging ?? canvas.focused) === h.id;
        return (
          <button
            key={h.id}
            ref={canvas.button(h.id)}
            type="button"
            aria-label={canvas.describe(h)}
            className={HANDLE}
            style={{ left: pct(p.x, imgW), top: pct(p.y, imgH) }}
            onKeyDown={(e) => canvas.onKeyDown(h, e)}
            onFocus={() => canvas.onFocus(h.id)}
            onBlur={() => canvas.onBlur(h.id)}
          >
            <span
              className={cx(
                "block rounded-full border border-white/90 shadow",
                isActive ? "h-3.5 w-3.5 ring-2 ring-white" : "h-2.5 w-2.5",
                h.primary && "ring-1 ring-white/70"
              )}
              style={{ backgroundColor: GROUP_COLOURS[h.group] }}
            />
          </button>
        );
      })}

      <MarkLoupe
        refs={canvas.loupe}
        imageUrl={imageUrl}
        imageSize={imageSize}
        marks={marks}
        handles={canvas.handles}
        active={canvas.active}
        lensPx={canvas.lensPx}
        size={canvas.size}
        inner={canvas.inner}
      />
    </div>
  );
}
