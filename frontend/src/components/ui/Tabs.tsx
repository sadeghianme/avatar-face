import type { ReactNode } from "react";

import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { cx } from "@/lib/cx";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
}

const LOOK = {
  // On a dark code window (the landing page's snippets).
  dark: {
    list: "flex gap-1",
    tab: "rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors coarse:min-h-11",
    on: "bg-white/10 text-white",
    off: "text-gray-400 hover:text-gray-200",
  },
} as const;

/**
 * A tab list (role="tablist"; the arrows move between tabs, one tab stop).
 * The panel is the caller's: give it id `panelId`, role="tabpanel" and
 * aria-labelledby `${idPrefix}-${value}` of the chosen tab.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  panelId,
  look = "dark",
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Each tab's id is `${idPrefix}-${value}`. */
  idPrefix: string;
  panelId: string;
  look?: keyof typeof LOOK;
  className?: string;
}) {
  const styles = LOOK[look];
  const tab = useRadioGroup(
    items.map((i) => i.value),
    value,
    onChange,
    undefined,
    "tab"
  );
  return (
    <div role="tablist" aria-label={label} className={cx(styles.list, className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          id={`${idPrefix}-${item.value}`}
          aria-controls={panelId}
          className={cx(styles.tab, item.value === value ? styles.on : styles.off)}
          {...tab(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
