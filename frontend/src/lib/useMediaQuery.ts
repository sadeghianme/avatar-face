import { useEffect, useState } from "react";

/**
 * A finger is the main pointer and the page is one column (below the
 * dashboard's `lg`, where the rail and the avatar page's 60/40 begin). A
 * swipe there is the page's scroll: nothing big in the column may take it
 * for a drag of its own.
 */
export const TOUCH_ONE_COLUMN = "(pointer: coarse) and (max-width: 1023px)";

/** A live media query: true while it matches, updated as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
