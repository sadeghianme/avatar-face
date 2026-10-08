import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CropGuides, CropShade } from "@/features/avatars/components/crop/CropGuides";
import {
  clamp01,
  type CropDrag,
  type CropRect,
  DEFAULT_RECT,
  dragTo,
  fitRatio,
  keyed,
  pixelSize,
  type Size,
  tooSmall as isTooSmall,
} from "@/features/avatars/crop";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";

export type { CropRect } from "@/features/avatars/crop";

/**
 * The crop interaction: an image, a rectangle, handles, aspect presets.
 *
 * Extracted so the avatar page and the creation wizard share one copy. Two
 * copies of a pointer-drag would drift, and this one already carries a fix
 * that is easy to lose: the drag lives in a ref because the first
 * pointermove of a gesture arrives before React has re-rendered from
 * pointerdown, so a state-held drag drops the first movement of every drag.
 *
 * Two ways to use it. The avatar page applies a crop with the box's own
 * Apply and Cancel. The wizard controls it (`value` + `onChange`, no
 * buttons): the crop is one half of a framing whose other half, the level,
 * is a slider next to it, and both are sent together when the step ends.
 * `turn` shows that level: the picture turns under the frame, which stays
 * put, exactly as the server will cut it (photo_io.frame_photo).
 *
 * The rectangle takes focus: arrow keys move it, Shift + arrow keys resize
 * it from its right and bottom edges, so the crop does not need a pointer.
 * It is an "application" region, not a group: a screen reader in browse mode
 * keeps the arrow keys for reading unless the focused element is a widget,
 * and the key handler would never hear them. Where the box is, and how big,
 * is part of its description and is read out after each key. The geometry
 * is crop.ts's; the shade, outline and handles are CropGuides'.
 */

const ASPECTS: { key: MessageKey; ratio: number | null }[] = [
  { key: "cropFree", ratio: null },
  { key: "cropSquare", ratio: 1 },
  { key: "cropPortrait", ratio: 4 / 5 },
  { key: "cropWide", ratio: 16 / 9 },
];

export function CropBox({
  src,
  busy = false,
  onApply,
  onCancel,
  value,
  onChange,
  turn = 0,
}: {
  src: string;
  busy?: boolean;
  /** With onCancel, shows Apply and Cancel under the picture. */
  onApply?: (rect: CropRect) => void;
  onCancel?: () => void;
  /** Controlled rectangle; the box keeps its own when omitted. */
  value?: CropRect;
  onChange?: (rect: CropRect) => void;
  /** Degrees the picture is levelled by (the roll to remove). */
  turn?: number;
}) {
  const { t } = useT();
  const frame = useRef<HTMLDivElement>(null);
  const keysHintId = useId();
  const positionId = useId();
  // Filled by key presses only: a pointer drag would read out every pixel.
  const [spoken, setSpoken] = useState("");
  const [own, setOwn] = useState<CropRect>(value ?? DEFAULT_RECT);
  const rect = value ?? own;
  const setRect = (next: CropRect) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  // The drag lives in a ref, not state: the first pointermove of a gesture
  // arrives before React has re-rendered from pointerdown, so a state-held
  // drag reads null and the first movement of every drag is dropped. The
  // boolean mirror exists only so the thirds grid can appear.
  const dragRef = useRef<CropDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<Size | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);

  const at = (e: React.PointerEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const start = (e: React.PointerEvent, next: CropDrag) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = next;
    setDragging(true);
    // Capture on currentTarget: the pointer leaves a 12px handle immediately,
    // and without this the drag would be delivered to whatever is beneath.
    // After the ref, so a browser that refuses capture still drags.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
  };

  const end = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const move = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) setRect(dragTo(drag, at(e), ratio, natural));
  };

  const chooseRatio = (next: number | null) => {
    setRatio(next);
    if (next && natural) setRect(fitRatio(rect, next, natural));
  };

  const describe = (r: CropRect) => {
    const pc = (v: number) => Math.round(v * 100);
    const text = t("cropAreaPosition", { left: pc(r.x), top: pc(r.y), width: pc(r.w), height: pc(r.h) });
    return natural ? `${text} (${pixelSize(r, natural)} px)` : text;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = keyed(rect, e.key, e.shiftKey, ratio, natural);
    if (!next) return;
    e.preventDefault();
    setRect(next);
    setSpoken(describe(next));
  };

  const tooSmall = isTooSmall(rect);
  const pct = (v: number) => `${v * 100}%`;

  return (
    <div>
      <div
        ref={frame}
        className="relative touch-none select-none overflow-hidden rounded-xl bg-black"
        onPointerMove={move}
        onPointerUp={() => end()}
        onPointerCancel={() => end()}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          className="block w-full"
          style={
            turn
              ? {
                  // The frame stays, the picture turns under it about the
                  // crop's centre, as the server levels it.
                  transform: `rotate(${-turn}deg)`,
                  transformOrigin: `${(rect.x + rect.w / 2) * 100}% ${(rect.y + rect.h / 2) * 100}%`,
                }
              : undefined
          }
        />

        <CropShade rect={rect} />

        <div
          className="absolute cursor-move outline-none focus-visible:ring-2 focus-visible:ring-brand-400
            focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
          tabIndex={0}
          role="application"
          aria-roledescription={t("cropAreaRole")}
          aria-label={t("cropAreaLabel")}
          aria-describedby={`${keysHintId} ${positionId}`}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            const p = at(e);
            start(e, { kind: "move", grabX: p.x, grabY: p.y, start: rect });
          }}
          onPointerMove={move}
          onPointerUp={() => end()}
        >
          <CropGuides
            tooSmall={tooSmall}
            dragging={dragging}
            onHandleDown={(e, handle) => start(e, { kind: "resize", handle, start: rect })}
            onMove={move}
            onEnd={end}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          label={t("cropRatio")}
          options={ASPECTS.map((a) => ({ value: a.key, label: t(a.key) }))}
          value={ASPECTS.find((a) => a.ratio === ratio)?.key ?? "cropFree"}
          onChange={(key) => chooseRatio(ASPECTS.find((a) => a.key === key)?.ratio ?? null)}
        />
        <span className="font-mono text-[12px] text-gray-400">{pixelSize(rect, natural)}</span>
        {onApply && onCancel && (
          <div className="ms-auto flex gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button icon="crop" disabled={busy || tooSmall} onClick={() => onApply(rect)}>
              {busy ? t("loading") : t("cropApply")}
            </Button>
          </div>
        )}
      </div>

      <p id={keysHintId} className="sr-only">
        {t("cropKeysHint")}
      </p>
      <p id={positionId} className="sr-only">
        {describe(rect)}
      </p>
      {/* Always mounted, so each change is read out. */}
      <p className="sr-only" aria-live="polite" role="status">
        {spoken}
      </p>
      {tooSmall && <FieldError className="mt-2">{t("cropTooSmall")}</FieldError>}
    </div>
  );
}
