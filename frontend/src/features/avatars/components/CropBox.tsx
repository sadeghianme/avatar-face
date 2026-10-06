import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

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
 * is part of its description and is read out after each key.
 */

/** Fractions of the image, so the rectangle survives any display size. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  { kind: "move"; grabX: number; grabY: number; start: Rect } | { kind: "resize"; handle: Handle; start: Rect };

/** Matches the server, which refuses to leave a face with nothing on it. */
const MIN_SIDE = 0.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// One arrow key press moves or resizes the rectangle by this share of the
// image. There is no fast variant: Shift already means resize, and 1% is
// fine enough for a crop and quick enough to cross a photo.
const KEY_STEP = 0.01;
// A keyboard resize stops here; the pointer can go smaller and is told off
// by the red outline, but a held key would otherwise collapse the box.
const KEY_MIN_SIDE = 0.05;
const DEFAULT_RECT: Rect = { x: 0.08, y: 0.04, w: 0.84, h: 0.92 };

const ASPECTS: { key: string; ratio: number | null }[] = [
  { key: "cropFree", ratio: null },
  { key: "cropSquare", ratio: 1 },
  { key: "cropPortrait", ratio: 4 / 5 },
  { key: "cropWide", ratio: 16 / 9 },
];

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const keysHintId = useId();
  const positionId = useId();
  // Filled by key presses only: a pointer drag would read out every pixel.
  const [spoken, setSpoken] = useState("");
  const [own, setOwn] = useState<Rect>(value ?? DEFAULT_RECT);
  const rect = value ?? own;
  const setRect = (next: Rect) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  // The drag lives in a ref, not state: the first pointermove of a gesture
  // arrives before React has re-rendered from pointerdown, so a state-held
  // drag reads null and the first movement of every drag is dropped. The
  // boolean mirror exists only so the thirds grid can appear.
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [error] = useState<string | null>(null);

  const at = (e: React.PointerEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  /** Force a rectangle to the locked aspect, holding the given anchor still. */
  const applyRatio = (r: Rect, anchorRight: boolean, anchorBottom: boolean): Rect => {
    if (!ratio || !natural) return r;
    // The rectangle is in fractions of two different dimensions, so the pixel
    // aspect is not w/h — it has to go through the image's own proportions.
    const h = (r.w * natural.w) / (ratio * natural.h);
    const next = { ...r, h };
    if (anchorBottom) next.y = r.y + r.h - h;
    if (next.y < 0) next.y = 0;
    if (next.y + next.h > 1) next.h = 1 - next.y;
    if (anchorRight) next.x = r.x + r.w - next.w;
    return next;
  };

  const start = (e: React.PointerEvent, next: Drag) => {
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
    if (!drag) return;
    const p = at(e);
    if (drag.kind === "move") {
      const s = drag.start;
      setRect({
        ...s,
        // Clamped so the box slides along the edge rather than shrinking when
        // it is pushed past the boundary.
        x: Math.max(0, Math.min(1 - s.w, s.x + (p.x - drag.grabX))),
        y: Math.max(0, Math.min(1 - s.h, s.y + (p.y - drag.grabY))),
      });
      return;
    }
    const s = drag.start;
    const h = drag.handle;
    const west = h === "nw" || h === "w" || h === "sw";
    const east = h === "ne" || h === "e" || h === "se";
    const north = h === "nw" || h === "n" || h === "ne";
    const south = h === "sw" || h === "s" || h === "se";

    let x0 = west ? p.x : s.x;
    let x1 = east ? p.x : s.x + s.w;
    let y0 = north ? p.y : s.y;
    let y1 = south ? p.y : s.y + s.h;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];

    setRect(applyRatio({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, east, south));
  };

  const chooseRatio = (next: number | null) => {
    setRatio(next);
    if (next && natural) {
      const h = (rect.w * natural.w) / (next * natural.h);
      const y = Math.max(0, Math.min(1 - Math.min(h, 1), rect.y));
      setRect({ ...rect, y, h: Math.min(h, 1 - y) });
    }
  };

  const describe = (r: Rect) => {
    const pc = (v: number) => Math.round(v * 100);
    const text = t("cropAreaPosition", { left: pc(r.x), top: pc(r.y), width: pc(r.w), height: pc(r.h) });
    return natural ? `${text} (${Math.round(r.w * natural.w)} × ${Math.round(r.h * natural.h)} px)` : text;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const dx = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
    const dy = e.key === "ArrowUp" ? -KEY_STEP : e.key === "ArrowDown" ? KEY_STEP : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    let next: Rect;
    if (e.shiftKey) {
      const w = Math.max(KEY_MIN_SIDE, Math.min(1 - rect.x, rect.w + dx));
      const h = Math.max(KEY_MIN_SIDE, Math.min(1 - rect.y, rect.h + dy));
      next = applyRatio({ ...rect, w, h }, false, false);
    } else {
      next = {
        ...rect,
        x: Math.max(0, Math.min(1 - rect.w, rect.x + dx)),
        y: Math.max(0, Math.min(1 - rect.h, rect.y + dy)),
      };
    }
    setRect(next);
    setSpoken(describe(next));
  };

  const tooSmall = rect.w < MIN_SIDE || rect.h < MIN_SIDE;
  const outPx = natural ? `${Math.round(rect.w * natural.w)} × ${Math.round(rect.h * natural.h)}` : "";

  const pct = (v: number) => `${v * 100}%`;
  const edge = "absolute bg-white/90";

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

        {/* Dim the four bands outside the crop rather than putting one big
            shadow behind it: this shows exactly what is being cut. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 top-0 bg-black/60" style={{ height: pct(rect.y) }} />
          <div
            className="absolute inset-x-0 bottom-0 bg-black/60"
            style={{ height: pct(Math.max(0, 1 - rect.y - rect.h)) }}
          />
          <div
            className="absolute left-0 bg-black/60"
            style={{ top: pct(rect.y), height: pct(rect.h), width: pct(rect.x) }}
          />
          <div
            className="absolute right-0 bg-black/60"
            style={{
              top: pct(rect.y),
              height: pct(rect.h),
              width: pct(Math.max(0, 1 - rect.x - rect.w)),
            }}
          />
        </div>

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
          <div className={`absolute inset-0 ring-1 ${tooSmall ? "ring-red-400" : "ring-white/70"}`} />
          {/* Thirds, shown only while dragging — permanent guides turn into
              clutter the moment you stop needing them. */}
          {dragging && (
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/30" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/30" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/30" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/30" />
            </div>
          )}

          {/* Corner brackets, the way a real crop tool draws them: they sit
              inside the frame so they never hide the edge they define. */}
          {(
            [
              ["nw", "left-0 top-0 border-l-[3px] border-t-[3px] cursor-nwse-resize"],
              ["ne", "right-0 top-0 border-r-[3px] border-t-[3px] cursor-nesw-resize"],
              ["sw", "bottom-0 left-0 border-b-[3px] border-l-[3px] cursor-nesw-resize"],
              ["se", "bottom-0 right-0 border-b-[3px] border-r-[3px] cursor-nwse-resize"],
            ] as [Handle, string][]
          ).map(([handle, cls]) => (
            <span
              key={handle}
              onPointerDown={(e) => start(e, { kind: "resize", handle, start: rect })}
              onPointerMove={move}
              onPointerUp={() => end()}
              className={`absolute h-6 w-6 border-white ${cls}`}
            />
          ))}

          {/* Edge bars — resizing one side only is half of what a crop tool
              is for, and corners alone force you to fight the aspect. */}
          {(
            [
              ["n", `${edge} left-1/2 top-0 h-[3px] w-7 -translate-x-1/2 cursor-ns-resize`],
              ["s", `${edge} bottom-0 left-1/2 h-[3px] w-7 -translate-x-1/2 cursor-ns-resize`],
              ["w", `${edge} left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 cursor-ew-resize`],
              ["e", `${edge} right-0 top-1/2 h-7 w-[3px] -translate-y-1/2 cursor-ew-resize`],
            ] as [Handle, string][]
          ).map(([handle, cls]) => (
            <span
              key={handle}
              onPointerDown={(e) => start(e, { kind: "resize", handle, start: rect })}
              onPointerMove={move}
              onPointerUp={() => end()}
              className={cls}
            />
          ))}
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
        <span className="font-mono text-[12px] text-gray-400">{outPx}</span>
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
      {tooSmall && <p className="field-error mt-2">{t("cropTooSmall")}</p>}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
