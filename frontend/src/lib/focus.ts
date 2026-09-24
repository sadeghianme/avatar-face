/**
 * Keyboard focus helpers for modal dialogs. Framework-free, so the wrap
 * rule is tested with `node --test`.
 */

/** Elements a Tab can land on. Disabled controls and tabindex=-1 are
 * filtered by the caller's query (see focusableIn). */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Where Tab (or Shift+Tab) goes from position `current` among `count`
 * focusable elements, wrapping at both ends so focus never leaves the
 * dialog. `current` of -1 means focus is outside them (on the dialog
 * itself): Tab enters at the first, Shift+Tab at the last. -1 when there is
 * nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

/** The focusable elements inside `root`, in document order, visible ones only. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0
  );
}

/** What is true of an element a dialog hands focus back to. */
export interface FocusReturn {
  isConnected: boolean;
  disabled: boolean;
}

/**
 * Where focus goes when a dialog closes, for the element that opened it:
 * - "now": it is there and can take focus;
 * - "wait": it is disabled, usually because the request that opened the
 *   dialog is still running (focus() on a disabled button does nothing,
 *   and focus would drop to <body>), so it is given focus once enabled;
 * - "none": it is gone.
 */
export function focusReturn(opener: FocusReturn | null): "now" | "wait" | "none" {
  if (!opener || !opener.isConnected) return "none";
  return opener.disabled ? "wait" : "now";
}

/** How long a disabled opener is waited for before giving up. */
export const FOCUS_RETURN_TIMEOUT_MS = 30_000;

/**
 * Give focus back to `opener` now, or as soon as it is enabled again, as
 * long as focus is still nowhere in particular (on <body>) by then: a
 * keyboard user who moved on in the meantime is left where they are.
 * Returns a cancel function.
 */
export function returnFocus(opener: HTMLElement | null): () => void {
  const state = opener ? { isConnected: opener.isConnected, disabled: isDisabled(opener) } : null;
  const when = focusReturn(state);
  if (!opener || when === "none") return () => undefined;
  if (when === "now") {
    opener.focus();
    return () => undefined;
  }
  const doc = opener.ownerDocument;
  const observer = new MutationObserver(() => {
    if (!opener.isConnected) return stop();
    if (isDisabled(opener)) return;
    stop();
    const active = doc.activeElement;
    if (active === null || active === doc.body) opener.focus();
  });
  const timer = window.setTimeout(() => stop(), FOCUS_RETURN_TIMEOUT_MS);
  function stop() {
    observer.disconnect();
    window.clearTimeout(timer);
  }
  observer.observe(opener, { attributes: true, attributeFilter: ["disabled"] });
  return stop;
}

function isDisabled(element: HTMLElement): boolean {
  return "disabled" in element && Boolean((element as HTMLButtonElement).disabled);
}
