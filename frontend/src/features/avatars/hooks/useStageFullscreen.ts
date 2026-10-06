import { type RefObject, useEffect, useState } from "react";

/**
 * The avatar page's stage, full screen: the browser's own fullscreen on
 * the element, or, where an element cannot have it (an iPhone: Safari
 * gives fullscreen to video only, and `requestFullscreen` is not there),
 * the stage covering the window over the shell. The same toggle or Escape
 * leaves either. `fullscreen` follows the document, so the toggle's icon
 * flips even when Escape left it, which never passes through the button.
 */
export function useStageFullscreen(box: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [box]);

  const [covering, setCovering] = useState(false);
  useEffect(() => {
    if (!covering) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCovering(false);
    };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [covering]);

  const toggle = () => {
    const el = box.current;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (covering) setCovering(false);
    else if (el && typeof el.requestFullscreen === "function" && document.fullscreenEnabled) {
      el.requestFullscreen().catch(() => setCovering(true));
    } else setCovering(true);
  };

  return { expanded: fullscreen || covering, covering, toggle };
}
