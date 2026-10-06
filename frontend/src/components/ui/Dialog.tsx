import { type ReactNode, useEffect, useRef } from "react";

import { cx } from "@/lib/cx";
import { focusableIn, nextFocusIndex, returnFocus } from "@/lib/focus";

/** The dialog's sheet: centred, 1rem clear of every edge, scrolling inside. */
const SHEET = cx(
  "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto rounded-2xl p-5 shadow-xl sm:p-6",
  "border border-gray-200 bg-white text-gray-900 backdrop:bg-black/50 dark:border-line dark:bg-panel dark:text-gray-100"
);

/**
 * A modal dialog: the native <dialog> opened with showModal(), which makes
 * the rest of the page inert and gives the dialog role and modality to
 * screen readers, plus the two things it does not do by itself:
 *
 * - Tab and Shift+Tab wrap inside the dialog. Without this, Tab from the
 *   last button walks out into the browser's own toolbar.
 * - Focus goes back where it was on close, so a keyboard user is not
 *   dropped at the top of the page after answering. The button that opened
 *   it is often disabled by then (its request waits on the answer), and a
 *   disabled button cannot take focus: it gets it once it is enabled again.
 *
 * Escape closes it through `onClose` (the "cancel" event is intercepted so
 * the parent's `open` stays the one source of truth). Focus opens on the
 * element marked `data-autofocus`, else the first focusable one.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Id of the dialog's heading. */
  labelledBy: string;
  describedBy?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read in the handlers below without re-running the effect when the
  // parent passes a new function on every render.
  const close = useRef(onClose);
  close.current = onClose;
  // A wait for a disabled opener (see returnFocus) outlives the dialog's
  // open state, not the component: stopped if it unmounts first.
  const pendingReturn = useRef<() => void>(() => {});

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusableIn(dialog)[0];
    first?.focus();
    // Closed, or unmounted while open: either way focus goes back.
    return () => {
      if (dialog.open) dialog.close();
      pendingReturn.current = returnFocus(opener);
    };
  }, [open]);
  useEffect(() => () => pendingReturn.current(), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab" || !ref.current) return;
    const items = focusableIn(ref.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(at, items.length, event.shiftKey);
    event.preventDefault();
    if (next >= 0) items[next].focus();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-modal="true"
      onCancel={(event) => {
        // Escape: let the parent decide, so `open` stays in step.
        event.preventDefault();
        close.current();
      }}
      onKeyDown={onKeyDown}
      className={SHEET}
    >
      {open ? children : null}
    </dialog>
  );
}
