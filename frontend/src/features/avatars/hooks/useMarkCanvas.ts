import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type LoupeRefs, placeLoupe } from "@/features/avatars/components/mark/MarkLoupe";
import {
  clampToImage,
  type FaceMarks,
  GROUP_LABELS,
  type Handle,
  handleAt,
  handlesFor,
  type Pt,
} from "@/features/avatars/face-marks";
import { useElementWidth } from "@/features/avatars/hooks/useElementWidth";
import { type Corner, LOUPE_ZOOM, loupeInner, loupeSize } from "@/features/avatars/loupe";
import { useT } from "@/i18n";

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
 * The marking canvas's behaviour (MarkCanvas draws it): a press picks the
 * NEAREST handle and drags it, a frame at a time; the arrow keys nudge the
 * focused one; and the zoom follows the pointer, the dragged handle or the
 * keys, painted straight into the DOM (its refs) rather than rendered, so
 * a drag does not render once per pixel.
 */
export function useMarkCanvas({
  imageSize: [imgW, imgH],
  marks,
  onChange,
}: {
  imageSize: [number, number];
  marks: FaceMarks;
  onChange: (marks: FaceMarks) => void;
}) {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const loupe: LoupeRefs = {
    box: useRef<HTMLDivElement>(null),
    lens: useRef<SVGSVGElement>(null),
    caption: useRef<HTMLParagraphElement>(null),
  };
  const buttons = useRef(new Map<string, HTMLButtonElement>());
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
  const width = useElementWidth(containerRef);
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
    const container = containerRef.current;
    const s = live.current;
    if (!container || s.scale <= 0) return;

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

    corner.current = placeLoupe(loupe, center, named ? s.describe(named) : "", s, corner.current);
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
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );
  // Scrolling moves the photo under a pointer that stays still: the zoom
  // follows on the scroll itself (a drag moves its handle along too). The
  // listener stays for the canvas's life and calls this render's schedule.
  const latestSchedule = useRef(schedule);
  latestSchedule.current = schedule;
  useEffect(() => {
    const onScroll = () => {
      if (lens.current.client) latestSchedule.current();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

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

  return {
    containerRef,
    loupe,
    handles,
    describe,
    dragging,
    focused,
    /** The handle the zoom is on: the one dragged, or the one the keys move. */
    active: dragging ?? (fromKeys ? focused : null),
    /** The zoom's own pixels, in image pixels: what its dots and dashes are
     *  sized in, so they read the same at every photo size. */
    lensPx: scale > 0 ? 1 / (scale * LOUPE_ZOOM) : 1,
    size,
    inner,
    pointer: {
      onPointerDown,
      onPointerMove: follow,
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: leave,
    },
    /** A handle's button, kept for the press that focuses it. */
    button: (id: string) => (element: HTMLButtonElement | null) => {
      if (element) buttons.current.set(id, element);
      else buttons.current.delete(id);
    },
    onKeyDown: (handle: Handle, event: React.KeyboardEvent) => {
      const step = KEYS[event.key];
      if (!step) return;
      event.preventDefault();
      lens.current = { client: null, touch: false };
      setFromKeys(true);
      const by = event.shiftKey ? NUDGE_FAST : NUDGE;
      const at = handle.at(marks);
      onChange(handle.move(marks, clampToImage({ x: at.x + step.x * by, y: at.y + step.y * by }, imgW, imgH)));
    },
    onFocus: (id: string) => {
      setFocused(id);
      if (!pressing.current) {
        lens.current = { client: null, touch: false };
        setFromKeys(true);
      }
    },
    onBlur: (id: string) => setFocused((current) => (current === id ? null : current)),
  };
}
