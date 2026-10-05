/**
 * Where a navigation leaves the scroll, as a rule (tested with `node --test`;
 * ScrollToTop applies it).
 *
 * A single-page app keeps the window where it was when the route changes,
 * so an avatar opened from the bottom of the list opened scrolled to its
 * own bottom, and going back and opening another landed there again. A new
 * page starts at the top. Not on the browser's Back and Forward (POP): the
 * browser puts the list back where the reader left it, which is what Back
 * is for. Not for an anchor (`#mouth-panel`): the anchor says where. And
 * not when only the query changed (the wizard's `?model=`, `?step=`): that
 * is the same page in another state, which keeps its own scroll.
 */
export type NavigationKind = "POP" | "PUSH" | "REPLACE";

export interface Place {
  pathname: string;
  hash: string;
}

export function scrollsToTop(previous: Place | null, next: Place, kind: NavigationKind): boolean {
  if (kind === "POP") return false;
  if (next.hash) return false;
  if (previous && previous.pathname === next.pathname) return false;
  return true;
}
