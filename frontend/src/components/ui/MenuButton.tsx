import { useEffect, useRef, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/lib/cx";

export interface MenuChoice {
  key: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
}

/**
 * An icon button that opens a small menu of exclusive choices
 * (menuitemradio, the chosen one ticked): the header's language. A click
 * away or Escape closes it. It opens at the end side (`end-0`), so in a
 * right-to-left page it does not hang off the screen.
 */
export function MenuButton({
  label,
  icon,
  choices,
  className,
}: {
  /** The trigger's name (aria-label and tooltip). */
  label: string;
  icon: IconName;
  choices: readonly MenuChoice[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onAway);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onAway);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div className={cx("relative", className)} ref={box}>
      <IconButton
        label={label}
        tooltip
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          role="menu"
          className="absolute end-0 z-50 mt-1 min-w-[9rem] overflow-hidden rounded-xl border border-black/[0.08] bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-panel"
        >
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="menuitemradio"
              aria-checked={choice.checked}
              onClick={() => {
                choice.onSelect();
                setOpen(false);
              }}
              className={cx(
                "flex w-full items-center gap-2 px-3 py-2 text-start text-[13.5px] transition-colors hover:bg-black/[0.04] coarse:min-h-11 coarse:text-[15px] dark:hover:bg-white/[0.06]",
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
