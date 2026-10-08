import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { menuMove, rovingTarget, typeaheadTarget } from "@/components/ui/roving";
import { cx } from "@/lib/cx";

export interface MenuChoice {
  key: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}

/** How long the type-ahead keeps the letters typed before starting over. */
const TYPEAHEAD_MS = 500;

/**
 * An icon button that opens a small menu of exclusive choices
 * (menuitemradio, the chosen one ticked): the header's language. It is the
 * WAI-ARIA menu button pattern, keyboard and all:
 *
 * - the button opens the menu on a click, Enter, Space or Down with the
 *   focus on the chosen item (the first when none is), Up on the last;
 * - in the menu, Down and Up move the focus and wrap, Home and End go to
 *   the ends, typing a letter goes to the next item that starts with it
 *   (roving.ts menuMove, typeaheadTarget);
 * - Enter or Space chooses the focused item, closes the menu and gives the
 *   focus back to the button; so does Escape, without choosing;
 * - Tab closes it and moves on from the button, as from any control; a
 *   click anywhere else closes it where the click went.
 *
 * The items are not tab stops (tabIndex -1): the menu holds the focus
 * while it is open. It opens at the end side (`end-0`), so in a
 * right-to-left page it does not hang off the screen.
 */
export function MenuButton({
  label,
  icon,
  choices,
  className,
}: {
  /** The trigger's name (aria-label and tooltip), and the menu's. */
  label: string;
  icon: IconName;
  choices: readonly MenuChoice[];
  className?: string;
}) {
  // Closed, or open with the item the focus starts on.
  const [open, setOpen] = useState<null | "chosen" | "last">(null);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const buttonId = `${id}-button`;
  const menuId = `${id}-menu`;

  const close = (refocus: boolean) => {
    setOpen(null);
    if (refocus) trigger.current?.focus();
  };

  // Into the menu as it opens: the chosen item, or the last one for Up.
  useEffect(() => {
    if (!open) return;
    const chosen = choices.findIndex((c) => c.checked);
    const at = open === "last" ? choices.length - 1 : Math.max(0, chosen);
    items.current[at]?.focus();
    typed.current = { text: "", at: 0 };
    // Only on opening: a choice that changes while open keeps the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A press anywhere else closes it, the focus left where it went.
  useEffect(() => {
    if (!open) return;
    const onAway = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onAway);
    return () => document.removeEventListener("pointerdown", onAway);
  }, [open]);

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(event.key === "ArrowUp" ? "last" : "chosen");
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = items.current.findIndex((item) => item === document.activeElement);
    const move = menuMove(event.key);
    if (move === null) {
      // The type-ahead: a printable key, no modifier but Shift.
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      const now = event.timeStamp;
      const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      const labels = choices.map((c) => c.label);
      const target = typeaheadTarget(labels, from, text);
      if (target !== undefined) items.current[target]?.focus();
      return;
    }
    if ("close" in move) {
      if (move.close === "escape") {
        event.preventDefault();
        close(true);
      } else {
        // Tab goes on from the button, as it would had the menu been shut:
        // the focus is put back on it, and the key's own move takes it on.
        close(true);
      }
      return;
    }
    event.preventDefault();
    if ("choose" in move) {
      if (from >= 0) choices[from].onSelect();
      close(true);
      return;
    }
    const indices = choices.map((_, i) => i);
    const target = rovingTarget(indices, Math.max(0, from), move);
    if (target !== undefined) items.current[target]?.focus();
  };

  return (
    <div className={cx("relative", className)} ref={box}>
      <IconButton
        ref={trigger}
        id={buttonId}
        label={label}
        tooltip
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen("chosen"))}
        onKeyDown={onTriggerKey}
      />
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          // Focusable by script only: the items hold the focus, the menu
          // hears their keys.
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="absolute end-0 z-50 mt-1 min-w-[9rem] overflow-hidden rounded-xl border border-black/[0.08] bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-panel"
        >
          {choices.map((choice, i) => (
            <button
              key={choice.key}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={choice.checked}
              tabIndex={-1}
              onClick={() => {
                choice.onSelect();
                close(true);
              }}
              className={cx(
                // The focused item is marked by its background, as a menu's
                // is, not by a ring: the focus moves item to item.
                "flex w-full items-center gap-2 px-3 py-2 text-start text-[13.5px] outline-none transition-colors hover:bg-black/[0.04] focus:bg-brand-50 focus:text-brand-700 coarse:min-h-11 coarse:text-[15px] dark:hover:bg-white/[0.06] dark:focus:bg-white/[0.1] dark:focus:text-white",
                choice.checked ? "font-medium" : "text-gray-600 dark:text-gray-300"
              )}
            >
              <Icon name="check" className={cx("h-3.5 w-3.5", !choice.checked && "opacity-0")} strokeWidth={2.4} />
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
