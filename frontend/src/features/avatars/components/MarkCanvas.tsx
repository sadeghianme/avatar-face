import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  clampToImage,
  closedCurvePath,
  GROUP_COLOURS,
  GROUP_LABELS,
  handleAt,
  handlesFor,
  headOutline,
  type FaceMarks,
  type Handle,
  type Pt,
} from "@/features/avatars/face-marks";
import {
  loupeCorner,
  loupeInner,
  loupeOrigin,
  loupeSize,
  loupeView,
  LOUPE_FRAME,
  LOUPE_ZOOM,
  type Corner,
} from "@/features/avatars/loupe";

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
// A press this close to a handle (screen px) picks it up: about a fingertip.
const REACH_PX = 20;
// Inside the zoom, in its own (CSS) pixels: the dots, and the outlines' dash.
const LENS_DOT_PX = 4;
const LENS_DOT_ACTIVE_PX = 5.5;
const LENS_DASH_PX = 6;
// The crosshair's arms stop this far from the centre, so the pixel being
// placed stays visible between them.
const CROSSHAIR_GAP_PX = 7;
// Between the zoom and the caption hanging off it, in CSS pixels.
const CAPTION_GAP_PX = 4;

const REGION_IDS = ["left_eye", "right_eye", "mouth"] as const;

/** The outlines between the marks, in image coordinates, so the handles read
 * as shapes: the head as the smooth oval through its outline points (the
 * curve the fit puts the face's edge on), an eye or a human mouth as the
 * shape through its four edges, the mouth line as the stroke it is, a pupil
 * as its circle. Drawn in the view and, again, in the zoom. */
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
      <path d={closedCurvePath(headOutline(marks.head, marks.chin))} {...stroke(GROUP_COLOURS.head)} />
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

const find = (handles: Handle[], id: string | null) => handles.find((h) => h.id === id) ?? null;

/** What the zoom is following, outside React state: it changes on every
 * pointer move, and a render per pixel would make dragging stutter. */
interface Lens {
  /** The pointer over the photo (a mouse or pen hovering, a finger down),
   * in CLIENT pixels, read into the photo whenever the zoom is painted: a
   * page scrolled under a pointer that stays still moves the photo, and no
   * pointer event says so. Null when there is none. */
  client: Pt | null;
  /** A finger, not a hovering pointer: it ends when the finger lifts. */
  touch: boolean;
}

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
  const loupeRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<SVGSVGElement>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [imgW, imgH] = imageSize;
  const [dragging, setDragging] = useState<string | null>(null);
  // The same, set the moment a drag starts or ends: pointer events can
  // arrive before the render that would update `dragging`.
  const held = useRef<string | null>(null);
  // Where the handle sat relative to the press, so a handle picked up from
  // a few pixels away does not jump under the pointer.
  const grab = useRef<Pt>({ x: 0, y: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  // Focus from a press only makes the arrow keys work on that handle; the
  // zoom follows the keys (Tab, or a nudge) until the pointer moves again.
  const pressing = useRef(false);
  const [fromKeys, setFromKeys] = useState(false);
  const lens = useRef<Lens>({ client: null, touch: false });
  const corner = useRef<Corner | null>(null);
  const frame = useRef<number | null>(null);
  const width = useWidth(containerRef);
  const handles = useMemo(() => handlesFor(marks), [marks]);

  const canvas = { width, height: imgW > 0 ? (width * imgH) / imgW : 0 };
  const scale = imgW > 0 ? width / imgW : 0;
  const size = loupeSize(canvas);
  const inner = loupeInner(size);

  const describe = (h: Handle) =>
    t("markHandleLabel", { part: t(GROUP_LABELS[h.group]), point: t(h.label, h.labelParams) });

  // This render's values, for the frame callback and the pointer handlers,
  // which run between renders.
  const live = useRef({ marks, handles, onChange, dragging, focused, fromKeys, scale, canvas, size, inner, describe });
  useLayoutEffect(() => {
    live.current = { marks, handles, onChange, dragging, focused, fromKeys, scale, canvas, size, inner, describe };
  });

  /** A point in client pixels, in image pixels. */
  const toImage = (client: Pt): Pt => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: ((client.x - rect.left) / rect.width) * imgW,
      y: ((client.y - rect.top) / rect.height) * imgH,
    };
  };

  /** Where the pointer is over the photo now, in image pixels: null when
   * there is none, or when the page scrolled the photo out from under it
   * (a drag, which has the pointer captured, follows it anywhere). */
  const pointerNow = (): Pt | null => {
    const client = lens.current.client;
    if (!client || !containerRef.current) return null;
    const p = toImage(client);
    const over = p.x >= 0 && p.y >= 0 && p.x <= imgW && p.y <= imgH;
    return over || held.current ? p : null;
  };

  /** Put the zoom where it belongs now, straight into the DOM. */
  const paint = () => {
    const box = loupeRef.current;
    const view = lensRef.current;
    const caption = captionRef.current;
    const container = containerRef.current;
    const s = live.current;
    if (!box || !view || !caption || !container || s.scale <= 0) return;

    // Dragging centres on the handle, a pointer on itself, the keys on the
    // handle they move; the caption names the handle in question, if any.
    const dragged = find(s.handles, held.current);
    const pointer = pointerNow();
    let center: Pt | null = null;
    let named: Handle | null = null;
    if (dragged) {
      center = dragged.at(s.marks);
      named = dragged;
    } else if (pointer) {
      center = pointer;
      // The handle a press here would pick up, stack order and all.
      named = handleAt(s.handles, s.marks, pointer, { x: s.scale, y: s.scale }, REACH_PX, s.focused);
    } else if (s.fromKeys && s.focused) {
      named = find(s.handles, s.focused);
      center = named?.at(s.marks) ?? null;
    }
    container.style.cursor = dragged ? "grabbing" : named && pointer && !lens.current.touch ? "grab" : "";

    if (!center) {
      box.style.opacity = "0";
      corner.current = null;
      return;
    }
    const screen = { x: center.x * s.scale, y: center.y * s.scale };
    corner.current = loupeCorner(screen, s.canvas, s.size, corner.current);
    const origin = loupeOrigin(corner.current, s.canvas, s.size);
    box.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
    box.style.opacity = "1";
    view.setAttribute("viewBox", loupeView(center, s.scale, s.inner));
    caption.textContent = named ? s.describe(named) : "";
    // Not `hidden`: line-clamp sets a display of its own, which wins over it.
    caption.style.display = named ? "" : "none";
    // The caption hangs off the zoom's side toward the middle of the photo,
    // never over what the zoom shows. As wide as the zoom, it cannot cover
    // the pointer either: that is always beside the zoom (loupeCorner).
    const gap = `${s.size.height + CAPTION_GAP_PX}px`;
    caption.style.top = corner.current.top ? gap : "auto";
    caption.style.bottom = corner.current.top ? "auto" : gap;
  };

  /** Moves are coalesced to one per frame: the drag, and the zoom. */
  const flush = () => {
    frame.current = null;
    const s = live.current;
    const dragged = find(s.handles, held.current);
    const pointer = pointerNow();
    if (dragged && pointer) {
      const to = clampToImage({ x: pointer.x + grab.current.x, y: pointer.y + grab.current.y }, imgW, imgH);
      const at = dragged.at(s.marks);
      if (to.x !== at.x || to.y !== at.y) s.onChange(dragged.move(s.marks, to));
    }
    paint();
  };
  const schedule = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  // Every render can move what the zoom shows (a nudge, a drag landing, a
  // resize): repaint after it, before the browser draws.
  useLayoutEffect(paint);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  // Scrolling moves the photo under a pointer that stays still: the zoom
  // follows on the scroll itself (a drag moves its handle along too).
  useEffect(() => {
    const onScroll = () => {
      if (lens.current.client) schedule();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgW, imgH]);

  const place = (h: Handle, to: Pt) => onChange(h.move(marks, clampToImage(to, imgW, imgH)));

  /** The pointer in image pixels, and screen pixels per image pixel. */
  const pointerAt = (event: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      at: toImage({ x: event.clientX, y: event.clientY }),
      scale: { x: rect.width / imgW, y: rect.height / imgH },
    };
  };

  const follow = (event: React.PointerEvent) => {
    lens.current = { client: { x: event.clientX, y: event.clientY }, touch: event.pointerType === "touch" };
    // The pointer took over from the keys.
    if (live.current.fromKeys) setFromKeys(false);
    schedule();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    follow(event);
    const { at, scale: s } = pointerAt(event);
    const handle = handleAt(handles, marks, at, s, REACH_PX, focused);
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
    held.current = handle.id;
    setDragging(handle.id);
  };

  const release = (event: React.PointerEvent) => {
    if (held.current && event.type === "pointerup") {
      // The handle lands where it was let go, not where the last frame
      // before the release left it.
      lens.current = { ...lens.current, client: { x: event.clientX, y: event.clientY } };
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      flush();
    }
    held.current = null;
    setDragging(null);
    // A finger lifted is no longer anywhere; a mouse still hovers.
    if (event.pointerType === "touch" || event.type === "pointercancel") {
      lens.current = { client: null, touch: false };
    }
    schedule();
  };

  const leave = () => {
    // A captured drag keeps its zoom until it is released.
    if (held.current) return;
    lens.current = { client: null, touch: false };
    schedule();
  };

  const onKeyDown = (handle: Handle, event: React.KeyboardEvent) => {
    const step = KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    lens.current = { client: null, touch: false };
    setFromKeys(true);
    const by = event.shiftKey ? NUDGE_FAST : NUDGE;
    const at = handle.at(marks);
    place(handle, { x: at.x + step.x * by, y: at.y + step.y * by });
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const dash = Math.max(imgW, imgH) / 90;
  // The zoom's own pixels, in image pixels: what its dots and dashes are
  // sized in, so they read the same at every photo size.
  const lensPx = scale > 0 ? 1 / (scale * LOUPE_ZOOM) : 1;
  const active = dragging ?? (fromKeys ? focused : null);
  const cx = inner.width / 2;
  const cy = inner.height / 2;
  const arms = [
    [0, cy, cx - CROSSHAIR_GAP_PX, cy],
    [cx + CROSSHAIR_GAP_PX, cy, inner.width, cy],
    [cx, 0, cx, cy - CROSSHAIR_GAP_PX],
    [cx, cy + CROSSHAIR_GAP_PX, cx, inner.height],
  ];

  return (
    <div
      ref={containerRef}
      className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-gray-100
        dark:bg-gray-700"
      style={{ aspectRatio: `${imgW} / ${imgH}` }}
      onPointerDown={onPointerDown}
      onPointerMove={follow}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={leave}
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
              if (!pressing.current) {
                lens.current = { client: null, touch: false };
                setFromKeys(true);
              }
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

      {/* The zoom. Its place, what it shows and its caption are painted
          straight into the DOM on each frame (see `paint`); React draws
          only what changes with the marks. */}
      <div
        ref={loupeRef}
        className="pointer-events-none absolute left-0 top-0 opacity-0 motion-safe:transition-opacity
          motion-safe:duration-100"
        style={{ width: size.width, height: size.height }}
        aria-hidden="true"
      >
        {/* The frame is inside the zoom's size, and what it shows fills
            the rest (loupeInner): exactly three times the photo. */}
        <div
          className="relative h-full w-full overflow-hidden border-white bg-gray-900 shadow-lg ring-1
            ring-black/40"
          style={{ borderRadius: 10, borderWidth: LOUPE_FRAME }}
        >
          <svg ref={lensRef} className="block h-full w-full" preserveAspectRatio="none">
            <image href={imageUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="none" />
            <Outlines marks={marks} dash={LENS_DASH_PX * lensPx} />
            {handles.map((h) => {
              const p = h.at(marks);
              return (
                <circle
                  key={h.id}
                  cx={p.x}
                  cy={p.y}
                  r={(h.id === active ? LENS_DOT_ACTIVE_PX : LENS_DOT_PX) * lensPx}
                  fill={GROUP_COLOURS[h.group]}
                  stroke="white"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          {/* The crosshair marks the zoom's centre: the pixel under the
              pointer, or the handle's exact spot. A dark line under a light
              one, so it shows on skin, fur and a white backdrop alike. */}
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${inner.width} ${inner.height}`}
            preserveAspectRatio="none"
          >
            {arms.map(([x1, y1, x2, y2], i) => (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="black" strokeOpacity={0.45} strokeWidth={3} />
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth={1} />
              </g>
            ))}
          </svg>
        </div>
        {/* What the pointer would pick up, or is moving, under the zoom (or
            over it, for a zoom at the bottom), not on it: a caption inside
            hid the half of what it named on a phone. Three lines hold the
            longest name on the narrowest zoom a phone shows. */}
        <p
          ref={captionRef}
          style={{ display: "none" }}
          className="absolute inset-x-0 line-clamp-3 rounded-md bg-gray-900/85 px-1.5 py-1 text-center
            text-[11px] font-medium leading-tight text-white shadow"
        />
      </div>
    </div>
  );
}
