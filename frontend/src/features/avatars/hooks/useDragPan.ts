import { type MutableRefObject, useEffect, useRef } from "react";

import { panned, type SceneDraft } from "@/features/avatars/scene";

/**
 * Dragging the preview pans. Pointer events, captured, so a drag that
 * leaves the box still ends cleanly; a frame at a time, so a fast drag
 * does not rebuild the viewport more often than it can be drawn. Off when
 * `enabled` is false (the box shows something else, or a swipe there must
 * scroll the page).
 *
 * `surface` is read by the caller at render, so a remounted preview box
 * gets the listeners again; `draft` is the scene as it is now, and
 * `change` the latest way to change it.
 */
export function useDragPan(
  surface: HTMLElement | null,
  enabled: boolean,
  draft: MutableRefObject<SceneDraft>,
  change: (next: SceneDraft) => void
): void {
  const changeRef = useRef(change);
  changeRef.current = change;

  useEffect(() => {
    const el = surface;
    if (!el || !enabled) return;
    const change = (next: SceneDraft) => changeRef.current(next);
    let drag: { x: number; y: number; pan: { x: number; y: number } } | null = null;
    let frame = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, pan: draft.current.pan };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const { x, y, pan } = drag;
      const rect = el.getBoundingClientRect();
      const next = panned(pan, e.clientX - x, e.clientY - y, rect.width, rect.height);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = draft.current;
        if (current.pan.x !== next.x || current.pan.y !== next.y) change({ ...current, pan: next });
      });
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    el.style.cursor = "grab";
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.style.cursor = "";
      el.style.touchAction = "";
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [surface, enabled, draft]);
}
