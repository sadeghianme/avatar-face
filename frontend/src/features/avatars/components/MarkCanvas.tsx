import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  clampToImage,
  GROUP_COLOURS,
  GROUP_LABELS,
  handleAt,
  handlesFor,
  type FaceMarks,
  type Handle,
  type Pt,
  type RegionId,
} from "@/features/avatars/face-marks";

// Arrow keys nudge a handle this far, in IMAGE pixels, and ten times that
// with Shift: a pixel of the photo, whatever size it is displayed at.
const NUDGE = 1;
const NUDGE_FAST = 10;
const KEYS: Record<string, Pt> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};
// The loupe shows this fraction of the photo's long side around the handle,
// magnified into a lens of LOUPE_PX, or LOUPE_SHARE of the canvas width if
// that is less: a lid or a lip corner is a few pixels of a phone-sized
// preview, and the finger dragging it covers the spot — but a full-size lens
// on a 300px phone canvas would cover half the face being marked.
const LOUPE_WINDOW = 1 / 9;
const LOUPE_PX = 150;
const LOUPE_SHARE = 0.35;
// Room kept under the lens for its caption (three lines on a phone's lens),
// and between the loupe and the canvas edge.
const CAPTION_PX = 44;
const LOUPE_INSET_PX = 8;
// A press this close to a handle (screen px) picks it up: about a fingertip.
const REACH_PX = 20;

type Corner = { top: boolean; left: boolean };
const CORNERS: Corner[] = [
  { top: true, left: false },
  { top: true, left: true },
  { top: false, left: false },
  { top: false, left: true },
];

const REGION_IDS: RegionId[] = ["head", "left_eye", "right_eye", "mouth"];

/** The outlines between the marks, in image coordinates, so the handles read
 * as shapes: a region as a closed curve through its four edges, the mouth
 * line as the stroke it is, a pupil as its circle. Drawn in the view and,
 * again, in the loupe. */
function Outlines({ marks, dash }: { marks: FaceMarks; dash: number }) {
  const stroke = (colour: string) => ({
    fill: "none",
    stroke: colour,
    strokeWidth: 1.5,
    strokeDasharray: `${dash} ${dash * 0.6}`,
    vectorEffect: "non-scaling-stroke" as const,
  });
  return (
    <>
      {REGION_IDS.map((id) => {
        const m = marks[id];
        if (!m) return null;
        const points = [m.top, m.right, m.bottom, m.left].map((p) => `${p.x},${p.y}`).join(" ");
        return <polygon key={id} points={points} {...stroke(GROUP_COLOURS[id])} />;
      })}
      {marks.mouth_line && (
        <polyline
          points={marks.mouth_line.map((p) => `${p.x},${p.y}`).join(" ")}
          {...stroke(GROUP_COLOURS.mouth_line)}
          strokeDasharray="none"
        />
      )}
      {marks.chin && marks.mouth_line && (
        // From the middle of the mouth down to the chin: the jaw it sets.
        <line
          x1={marks.mouth_line[2].x}
          y1={marks.mouth_line[2].y}
          x2={marks.chin.x}
          y2={marks.chin.y}
          {...stroke(GROUP_COLOURS.chin)}
        />
      )}
      {(["left_pupil", "right_pupil"] as const).map((id) => {
        const p = marks[id];
        if (!p) return null;
        const r = Math.hypot(p.rim.x - p.center.x, p.rim.y - p.center.y);
        return <circle key={id} cx={p.center.x} cy={p.center.y} r={r} {...stroke(GROUP_COLOURS[id])} />;
      })}
    </>
  );
}

/**
 * The canvas corner for the loupe: never over the handle it magnifies, and
 * over as few other handles as possible — on a phone the lens is a third of
 * the face, and a corner chosen by the handle's side alone could hide a
 * whole eye. Ties go to the corner farthest from the handle.
 */
function loupeCorner(
  points: Pt[],
  at: Pt,
  lens: number,
  canvas: { width: number; height: number; scale: number }
): Corner {
  // A handle's dot is ~10px across: one half inside the rect is covered.
  const margin = 6;
  const h = lens + CAPTION_PX;
  const screen = (p: Pt) => ({ x: p.x * canvas.scale, y: p.y * canvas.scale });
  const target = screen(at);
  let best = CORNERS[0];
  let bestScore = Infinity;
  for (const corner of CORNERS) {
    const x0 = corner.left ? LOUPE_INSET_PX : canvas.width - LOUPE_INSET_PX - lens;
    const y0 = corner.top ? LOUPE_INSET_PX : canvas.height - LOUPE_INSET_PX - h;
    const covers = (p: Pt) =>
      p.x > x0 - margin && p.x < x0 + lens + margin && p.y > y0 - margin && p.y < y0 + h + margin;
    if (covers(target)) continue;
    const hidden = points.map(screen).filter(covers).length;
    const away = Math.hypot(x0 + lens / 2 - target.x, y0 + h / 2 - target.y);
    // Fewest hidden first; distance only breaks ties (it is under 1e4 px).
    const score = hidden * 1e4 - away;
    if (score < bestScore) {
      best = corner;
      bestScore = score;
    }
  }
  return best;
}

/** The element's width in CSS pixels, kept current as it resizes. */
function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The photo with its marks: press near a handle and drag it, or Tab to one
 * and nudge it with the arrow keys. While a handle is held, or being nudged,
 * a loupe shows the photo around it magnified, since the point being placed
 * is usually smaller than the pointer placing it.
 *
 * A press picks the NEAREST handle (face-marks `handleAt`), never the button
 * under the pointer: the handles are closer together than their buttons are
 * wide, and the button painted last would win every overlap. The buttons are
 * there for the keyboard and for screen readers only.
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
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [imgW, imgH] = imageSize;
  const [dragging, setDragging] = useState<string | null>(null);
  // Where the handle sat relative to the press, so a handle picked up from
  // a few pixels away does not jump under the pointer.
  const grab = useRef<Pt>({ x: 0, y: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  // Focus from a press only makes the arrow keys work on that handle; the
  // loupe stays for the keys (Tab, or a nudge), and goes when the press ends.
  const pressing = useRef(false);
  const [fromKeys, setFromKeys] = useState(false);
  const width = useWidth(containerRef);
  const handles = useMemo(() => handlesFor(marks), [marks]);
  const byId = (id: string | null) => handles.find((h) => h.id === id) ?? null;
  const active = byId(dragging) ?? (fromKeys ? byId(focused) : null);

  const describe = (h: Handle) =>
    t("markHandleLabel", { part: t(GROUP_LABELS[h.group]), point: t(h.label, h.labelParams) });
  const place = (h: Handle, to: Pt) => onChange(h.move(marks, clampToImage(to, imgW, imgH)));

  /** The pointer in image pixels, and screen pixels per image pixel. */
  const pointer = (event: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      at: {
        x: ((event.clientX - rect.left) / rect.width) * imgW,
        y: ((event.clientY - rect.top) / rect.height) * imgH,
      },
      scale: { x: rect.width / imgW, y: rect.height / imgH },
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const { at, scale } = pointer(event);
    const handle = handleAt(handles, marks, at, scale, REACH_PX, focused);
    if (!handle) return;
    // No native drag or text selection; focus by hand, so the arrow keys
    // work on the handle just picked up.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = handle.at(marks);
    grab.current = { x: p.x - at.x, y: p.y - at.y };
    pressing.current = true;
    buttons.current.get(handle.id)?.focus();
    pressing.current = false;
    setFromKeys(false);
    setDragging(handle.id);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const handle = byId(dragging);
    if (!handle) return;
    const { at } = pointer(event);
    place(handle, { x: at.x + grab.current.x, y: at.y + grab.current.y });
  };

  const onKeyDown = (handle: Handle, event: React.KeyboardEvent) => {
    const step = KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    setFromKeys(true);
    const by = event.shiftKey ? NUDGE_FAST : NUDGE;
    const at = handle.at(marks);
    place(handle, { x: at.x + step.x * by, y: at.y + step.y * by });
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const dash = Math.max(imgW, imgH) / 90;

  let loupe = null;
  if (active && width > 0) {
    const at = active.at(marks);
    const win = Math.max(imgW, imgH) * LOUPE_WINDOW;
    const lens = Math.min(LOUPE_PX, width * LOUPE_SHARE);
    const corner = loupeCorner(
      handles.map((h) => h.at(marks)), at, lens,
      { width, height: (width * imgH) / imgW, scale: width / imgW }
    );
    loupe = (
      <div
        className="pointer-events-none absolute flex flex-col items-center gap-1"
        style={{
          width: lens,
          [corner.top ? "top" : "bottom"]: LOUPE_INSET_PX,
          [corner.left ? "left" : "right"]: LOUPE_INSET_PX,
        }}
        aria-hidden="true"
      >
        <svg
          viewBox={`${at.x - win / 2} ${at.y - win / 2} ${win} ${win}`}
          className="rounded-full border-2 border-white bg-gray-900 shadow-lg"
          style={{ width: lens, height: lens }}
        >
          <image href={imageUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="none" />
          <Outlines marks={marks} dash={win / 30} />
          {handles.map((h) => {
            const p = h.at(marks);
            return (
              <circle
                key={h.id}
                cx={p.x}
                cy={p.y}
                r={win / (h.id === active.id ? 45 : 70)}
                fill={GROUP_COLOURS[h.group]}
                stroke="white"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          <g stroke="white" strokeWidth={1} opacity={0.8}>
            <line x1={at.x - win / 2} y1={at.y} x2={at.x - win / 12} y2={at.y} vectorEffect="non-scaling-stroke" />
            <line x1={at.x + win / 12} y1={at.y} x2={at.x + win / 2} y2={at.y} vectorEffect="non-scaling-stroke" />
            <line x1={at.x} y1={at.y - win / 2} x2={at.x} y2={at.y - win / 12} vectorEffect="non-scaling-stroke" />
            <line x1={at.x} y1={at.y + win / 12} x2={at.x} y2={at.y + win / 2} vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
        <p className="w-full rounded-md bg-gray-900/80 px-1.5 py-0.5 text-center text-[10px]
          font-medium leading-tight text-white">
          {describe(active)}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-gray-100
        dark:bg-gray-700"
      style={{ aspectRatio: `${imgW} / ${imgH}` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDragging(null)}
      onPointerCancel={() => setDragging(null)}
    >
      <img src={imageUrl} alt="" className="h-full w-full object-fill" draggable={false} />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={`0 0 ${imgW} ${imgH}`}
        preserveAspectRatio="none"
      >
        <Outlines marks={marks} dash={dash} />
      </svg>

      {handles.map((h) => {
        const p = h.at(marks);
        const isActive = (dragging ?? focused) === h.id;
        const label = describe(h);
        return (
          <button
            key={h.id}
            ref={(element) => {
              if (element) buttons.current.set(h.id, element);
              else buttons.current.delete(h.id);
            }}
            type="button"
            aria-label={label}
            className="pointer-events-none absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2
              items-center justify-center rounded-full outline-none focus-visible:ring-2
              focus-visible:ring-white"
            style={{ left: pct(p.x, imgW), top: pct(p.y, imgH) }}
            onKeyDown={(e) => onKeyDown(h, e)}
            onFocus={() => {
              setFocused(h.id);
              if (!pressing.current) setFromKeys(true);
            }}
            onBlur={() => setFocused((current) => (current === h.id ? null : current))}
          >
            <span
              className={`block rounded-full border border-white/90 shadow
                ${isActive ? "h-3.5 w-3.5 ring-2 ring-white" : "h-2.5 w-2.5"}
                ${h.primary ? "ring-1 ring-white/70" : ""}`}
              style={{ backgroundColor: GROUP_COLOURS[h.group] }}
            />
          </button>
        );
      })}

      {loupe}
    </div>
  );
}
