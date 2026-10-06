import { useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

import { type Place, scrollsToTop } from "@/app/scroll";

/**
 * Every new route starts at the top of the window (app/scroll.ts has the
 * rule and why). Before the paint, so the new page is never seen at the old
 * page's scroll for a frame. Mounted once inside the router.
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation();
  const kind = useNavigationType();
  const previous = useRef<Place | null>(null);
  useLayoutEffect(() => {
    const here = { pathname, hash };
    if (scrollsToTop(previous.current, here, kind)) window.scrollTo(0, 0);
    previous.current = here;
  }, [pathname, hash, kind]);
  return null;
}
