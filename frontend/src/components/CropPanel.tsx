import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { api } from "../lib/api";
import type { Avatar } from "../lib/types";

/** The crop rectangle, in fractions of the image so it survives any display size. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Drag =
  | { kind: "new"; originX: number; originY: number }
  | { kind: "move"; grabX: number; grabY: number; start: Rect }
  | { kind: "resize"; corner: Corner; start: Rect };

type Corner = "nw" | "ne" | "sw" | "se";

/** Matches the server, which refuses to leave a face with nothing on it. */
const MIN_SIDE = 0.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Normalise a rectangle so width and height are positive after a backwards drag. */
function tidy(rect: Rect): Rect {
  const x = Math.min(rect.x, rect.x + rect.w);
  const y = Math.min(rect.y, rect.y + rect.h);
  return { x, y, w: Math.abs(rect.w), h: Math.abs(rect.h) };
}

export function CropPanel({
  avatar,
  orgId,
  onClose,
}: {
  avatar: Avatar;
  orgId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const surface = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>({ x: 0.1, y: 0.05, w: 0.8, h: 0.9 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Pointer position as a fraction of the image box. */
  const at = (e: React.PointerEvent): { x: number; y: number } => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    };
  };

  const onPointerDown = (e: React.PointerEvent, next: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    // Capture on currentTarget, not target: the pointer leaves the handle the
    // instant the drag starts, and events would go to whatever is underneath.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(next);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === "new") {
      setRect(tidy({ x: drag.originX, y: drag.originY, w: p.x - drag.originX, h: p.y - drag.originY }));
      return;
    }
    if (drag.kind === "move") {
      const { start } = drag;
      // Clamped so the rectangle slides along the edge instead of shrinking
      // when it is pushed past the boundary.
      setRect({
        ...start,
        x: Math.max(0, Math.min(1 - start.w, start.x + (p.x - drag.grabX))),
        y: Math.max(0, Math.min(1 - start.h, start.y + (p.y - drag.grabY))),
      });
      return;
    }
    const s = drag.start;
    const left = drag.corner === "nw" || drag.corner === "sw";
    const top = drag.corner === "nw" || drag.corner === "ne";
    const x0 = left ? p.x : s.x;
    const y0 = top ? p.y : s.y;
    const x1 = left ? s.x + s.w : p.x;
    const y1 = top ? s.y + s.h : p.y;
    setRect(tidy({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }));
  };

  const endDrag = () => setDrag(null);

  const tooSmall = rect.w < MIN_SIDE || rect.h < MIN_SIDE;

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
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/avatars/${avatar.id}/crop`, { reset: true });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">{t("cropTitle")}</h3>
          <p className="mt-0.5 text-[13px] text-gray-500 dark:text-gray-400">{t("cropHint")}</p>
        </div>
        <button className="btn-secondary" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>

      <div
        ref={surface}
        className="relative mx-auto max-w-md touch-none select-none overflow-hidden rounded-xl bg-black/[0.05] dark:bg-white/[0.06]"
        onPointerDown={(e) => {
          const p = at(e);
          onPointerDown(e, { kind: "new", originX: p.x, originY: p.y });
          setRect({ x: p.x, y: p.y, w: 0, h: 0 });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img
          src={avatar.image_url ?? avatar.thumbnail_url ?? ""}
          alt=""
          draggable={false}
          className="block w-full"
        />
        {/* Four panels rather than one box with a huge shadow: this dims
            exactly what is being cut away, which is the thing worth seeing. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: pct(rect.y) }} />
          <div
            className="absolute inset-x-0 bottom-0 bg-black/55"
            style={{ height: pct(Math.max(0, 1 - rect.y - rect.h)) }}
          />
          <div
            className="absolute left-0 bg-black/55"
            style={{ top: pct(rect.y), height: pct(rect.h), width: pct(rect.x) }}
          />
          <div
            className="absolute right-0 bg-black/55"
            style={{
              top: pct(rect.y),
              height: pct(rect.h),
              width: pct(Math.max(0, 1 - rect.x - rect.w)),
            }}
          />
        </div>

        <div
          className={`absolute cursor-move border-2 ${tooSmall ? "border-red-400" : "border-white"}`}
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
          onPointerDown={(e) => {
            const p = at(e);
            onPointerDown(e, { kind: "move", grabX: p.x, grabY: p.y, start: rect });
          }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
        >
          {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
            <span
              key={corner}
              onPointerDown={(e) => onPointerDown(e, { kind: "resize", corner, start: rect })}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              className={`absolute h-4 w-4 rounded-sm border-2 border-white bg-brand-500 ${
                corner === "nw"
                  ? "-left-2 -top-2 cursor-nwse-resize"
                  : corner === "ne"
                    ? "-right-2 -top-2 cursor-nesw-resize"
                    : corner === "sw"
                      ? "-bottom-2 -left-2 cursor-nesw-resize"
                      : "-bottom-2 -right-2 cursor-nwse-resize"
              }`}
            />
          ))}
        </div>
      </div>

      {tooSmall && <p className="field-error mt-3">{t("cropTooSmall")}</p>}
      {error && <p className="field-error mt-3">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy || tooSmall} onClick={() => void apply()}>
          <Icon name="crop" className="me-1.5 inline h-4 w-4" />
          {busy ? t("loading") : t("cropApply")}
        </button>
        {avatar.precrop_image_key && (
          <button className="btn-secondary" disabled={busy} onClick={() => void reset()}>
            {t("cropReset")}
          </button>
        )}
        <span className="ms-auto font-mono text-[12px] text-gray-400">
          {Math.round(rect.w * 100)}% × {Math.round(rect.h * 100)}%
        </span>
      </div>
    </div>
  );
}
