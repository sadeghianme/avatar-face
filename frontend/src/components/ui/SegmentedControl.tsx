import type { ReactNode } from "react";

import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { cx } from "@/lib/cx";

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** A tooltip, or a name when the label is an icon. */
  title?: string;
}

export type SegmentedLook = "solid" | "pill" | "outline" | "raised";

const LOOK: Record<SegmentedLook, { group: string; item: string; on: string; off: string }> = {
  // One bordered bar, the chosen part in ink (the Simulator's key, a crop's ratio).
  solid: {
    group: "flex overflow-hidden rounded-lg border border-black/10 dark:border-white/15",
    item: "text-[12.5px] font-medium transition-colors",
    on: "bg-gray-900 text-white dark:bg-white dark:text-gray-900",
    off: "text-gray-500 hover:bg-black/5 dark:hover:bg-white/10",
  },
  // A small pill inside a white frame, the chosen part in the brand colour.
  pill: {
    group: "inline-flex rounded-lg border border-black/10 bg-white p-0.5 dark:border-white/10 dark:bg-panel",
    item: "min-h-11 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
    on: "bg-brand-600 text-white",
    off: "text-gray-600 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.06]",
  },
  // A grey track, the chosen segment raised white on it (the wizard's views).
  raised: {
    group: "inline-flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.05]",
    item: cx(
      "inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition coarse:min-h-11 sm:px-4",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    ),
    on: "bg-white text-gray-900 shadow-sm ring-1 ring-black/5 dark:bg-raised dark:text-white dark:ring-white/10",
    off: "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white",
  },
  // Separate bordered buttons, the chosen one filled (a background's kind).
  outline: {
    group: "flex flex-wrap gap-2",
    item: "min-h-11 rounded-lg border px-3 text-sm font-medium",
    on: "border-brand-600 bg-brand-600 text-white",
    off: "border-gray-300 bg-white text-gray-700 dark:border-line dark:bg-panel dark:text-gray-200",
  },
};

/**
 * One choice among a few, drawn as one control (role="radiogroup"; one
 * tab stop, arrows move the choice: useRadioGroup). Name it with `label`
 * or `labelledBy`.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  describedBy,
  look = "solid",
  size = "md",
  selectOnMove = true,
  className,
  itemClassName,
}: {
  options: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  look?: SegmentedLook;
  /** The solid bar's segments: md (a tool's mode) or sm (a crop's ratio). */
  size?: "sm" | "md";
  /** false: the arrows move the focus, Space or Enter chooses (see useRadioGroup). */
  selectOnMove?: boolean;
  className?: string;
  /** Each segment's box (flex-1 to share the width). */
  itemClassName?: string;
}) {
  const styles = LOOK[look];
  const radio = useRadioGroup(
    options.map((o) => o.value),
    value,
    onChange,
    (v) => Boolean(options.find((o) => o.value === v)?.disabled),
    "radio",
    selectOnMove
  );
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cx(styles.group, className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={option.disabled}
          className={cx(
            styles.item,
            look === "solid" && (size === "sm" ? "px-2.5 py-1.5" : "px-3 py-2"),
            option.value === value ? styles.on : styles.off,
            itemClassName
          )}
          {...radio(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
