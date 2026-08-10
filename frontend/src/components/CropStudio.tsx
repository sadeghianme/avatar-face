import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { api } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * Cropping, in the preview itself.
 *
 * It used to open a second panel below with its own copy of the photo, so the
 * picture appeared twice and the crop was being judged somewhere other than
 * where the avatar actually lives. This replaces the preview in place: the box
 * you are looking at is the box you are cropping.
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
  | { kind: "move"; grabX: number; grabY: number; start: Rect }
  | { kind: "resize"; handle: Handle; start: Rect };

/** Matches the server, which refuses to leave a face with nothing on it. */
const MIN_SIDE = 0.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const ASPECTS: { key: string; ratio: number | null }[] = [
  { key: "cropFree", ratio: null },
  { key: "cropSquare", ratio: 1 },
  { key: "cropPortrait", ratio: 4 / 5 },
  { key: "cropWide", ratio: 16 / 9 },
];

export function CropStudio({
  avatar,
  orgId,
  onDone,
  onCancel,
}: {
  avatar: Avatar;
  orgId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>({ x: 0.08, y: 0.04, w: 0.84, h: 0.92 });
  // The drag lives in a ref, not state: the first pointermove of a gesture
  // arrives before React has re-rendered from pointerdown, so a state-held
  // drag reads null and the first movement of every drag is dropped. The
  // boolean mirror exists only so the thirds grid can appear.
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setRect((r) => {
        const h = (r.w * natural.w) / (next * natural.h);
        const y = Math.max(0, Math.min(1 - Math.min(h, 1), r.y));
        return { ...r, y, h: Math.min(h, 1 - y) };
      });
    }
  };

  const tooSmall = rect.w < MIN_SIDE || rect.h < MIN_SIDE;
  const outPx = natural
    ? `${Math.round(rect.w * natural.w)} × ${Math.round(rect.h * natural.h)}`
    : "";

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/avatars/${avatar.id}/crop`, {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

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
          src={avatar.image_url ?? avatar.thumbnail_url ?? ""}
          alt=""
          draggable={false}
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          className="block w-full"
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
          className="absolute cursor-move"
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
          onPointerDown={(e) => {
            const p = at(e);
            start(e, { kind: "move", grabX: p.x, grabY: p.y, start: rect });
          }}
          onPointerMove={move}
          onPointerUp={() => end()}
        >
          <div
            className={`absolute inset-0 ring-1 ${tooSmall ? "ring-red-400" : "ring-white/70"}`}
          />
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
        <div className="flex overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
          {ASPECTS.map((a) => (
            <button
              key={a.key}
              onClick={() => chooseRatio(a.ratio)}
              className={`px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                ratio === a.ratio
                  ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                  : "text-gray-500 hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              {t(a.key)}
            </button>
          ))}
        </div>
        <span className="font-mono text-[12px] text-gray-400">{outPx}</span>
        <div className="ms-auto flex gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
          <button className="btn-primary" disabled={busy || tooSmall} onClick={() => void apply()}>
            <Icon name="crop" className="me-1.5 inline h-4 w-4" />
            {busy ? t("loading") : t("cropApply")}
          </button>
        </div>
      </div>

      {tooSmall && <p className="field-error mt-2">{t("cropTooSmall")}</p>}
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
