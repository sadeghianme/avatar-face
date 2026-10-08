import type { PointerEvent } from "react";

import type { CropHandle, CropRect } from "@/features/avatars/crop";
import { cx } from "@/lib/cx";

const pct = (v: number) => `${v * 100}%`;
const edge = "absolute bg-white/90";

/** Corner brackets, the way a real crop tool draws them: they sit inside the
 *  frame so they never hide the edge they define. */
const CORNERS: [CropHandle, string][] = [
  ["nw", "left-0 top-0 border-l-[3px] border-t-[3px] cursor-nwse-resize"],
  ["ne", "right-0 top-0 border-r-[3px] border-t-[3px] cursor-nesw-resize"],
  ["sw", "bottom-0 left-0 border-b-[3px] border-l-[3px] cursor-nesw-resize"],
  ["se", "bottom-0 right-0 border-b-[3px] border-r-[3px] cursor-nwse-resize"],
];

/** Edge bars — resizing one side only is half of what a crop tool is for,
 *  and corners alone force you to fight the aspect. */
const EDGES: [CropHandle, string][] = [
  ["n", `${edge} left-1/2 top-0 h-[3px] w-7 -translate-x-1/2 cursor-ns-resize`],
  ["s", `${edge} bottom-0 left-1/2 h-[3px] w-7 -translate-x-1/2 cursor-ns-resize`],
  ["w", `${edge} left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 cursor-ew-resize`],
  ["e", `${edge} right-0 top-1/2 h-7 w-[3px] -translate-y-1/2 cursor-ew-resize`],
];

/** The four bands outside the crop, dimmed (rather than one big shadow
 *  behind it): this shows exactly what is being cut. */
export function CropShade({ rect }: { rect: CropRect }) {
  return (
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
  );
}

/**
 * Inside the crop: its outline (red when too small), the thirds while
 * dragging, and the handles a pointer resizes it by.
 */
export function CropGuides({
  tooSmall,
  dragging,
  onHandleDown,
  onMove,
  onEnd,
}: {
  tooSmall: boolean;
  dragging: boolean;
  onHandleDown: (event: PointerEvent, handle: CropHandle) => void;
  onMove: (event: PointerEvent) => void;
  onEnd: () => void;
}) {
  const handle = (id: CropHandle, className: string) => (
    <span
      key={id}
      onPointerDown={(e) => onHandleDown(e, id)}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      className={className}
    />
  );
  return (
    <>
      <div className={cx("absolute inset-0 ring-1", tooSmall ? "ring-red-400" : "ring-white/70")} />
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
      {CORNERS.map(([id, className]) => handle(id, cx("absolute h-6 w-6 border-white", className)))}
      {EDGES.map(([id, className]) => handle(id, className))}
    </>
  );
}
