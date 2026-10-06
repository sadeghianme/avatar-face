import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cx } from "@/lib/cx";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * filter: one of a row of filters, pressed when it is the one shown
   * (`selected`, aria-pressed) · suggestion: a pill that puts its words
   * somewhere (an example prompt).
   */
  variant?: "filter" | "suggestion";
  /** For a filter: whether it is the one applied. */
  selected?: boolean;
}

/** A small pill-shaped button (`.chip-*`); 44px tall under a finger. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { variant = "filter", selected, type = "button", className, ...rest },
  ref
) {
  const filter = variant === "filter";
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={filter ? Boolean(selected) : undefined}
      className={cx(
        filter ? "chip-filter" : "chip-suggestion",
        filter && (selected ? "chip-filter-on" : "chip-filter-off"),
        className
      )}
      {...rest}
    />
  );
});
