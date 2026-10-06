import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { cx } from "@/lib/cx";
import { focusableIn, nextFocusIndex } from "@/lib/focus";

/**
 * A panel that slides over the page from the start side, as a modal
 * (role="dialog"): focus moves in (to the current page's link, else the
 * first thing) and stays in (Tab wraps, lib/focus); Escape and the
 * backdrop close it; the page under it does not scroll; focus goes back to
 * `opener` on close. Widening the window to `closeAt` closes it too, so the
 * scroll lock never outlives it. It scrolls when a phone on its side is
 * shorter than its content.
 */
export function Drawer({
  open,
  onClose,
  label,
  closeLabel,
  id,
  opener,
  closeAt = "(min-width: 1024px)",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  label: string;
  /** The backdrop's name (it is a button, for a pointer). */
  closeLabel: string;
  id?: string;
  /** The button that opened it, where focus returns. */
  opener?: RefObject<HTMLElement>;
  /** A media query at which the drawer has no reason to be open. */
  closeAt?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    if (panel) {
      const items = focusableIn(panel);
      (items.find((el) => el.getAttribute("aria-current") === "page") ?? items[0])?.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    // Tab and Shift+Tab wrap inside the panel.
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panel) return;
      const items = focusableIn(panel);
      const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey);
      event.preventDefault();
      if (next >= 0) items[next].focus();
    };
    panel?.addEventListener("keydown", onTab);
    const wide = window.matchMedia(closeAt);
    const onWide = () => {
      if (wide.matches) close.current();
    };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    const button = opener?.current;
    return () => {
      root.style.overflow = overflow;
      panel?.removeEventListener("keydown", onTab);
      document.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected || panel?.contains(active)) {
        button?.focus({ preventScroll: true });
      }
    };
  }, [open, closeAt, opener]);

  if (!open) return null;
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={closeLabel}
        className="fixed inset-0 z-40 bg-black/50 lg:hidden"
        onClick={onClose}
      />
      <aside
        id={id}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={cx(
          "fixed inset-y-0 start-0 z-50 box-content overflow-y-auto overscroll-contain bg-white ps-[env(safe-area-inset-left)] lg:hidden dark:bg-panel",
          className
        )}
      >
        {children}
      </aside>
    </>
  );
}
