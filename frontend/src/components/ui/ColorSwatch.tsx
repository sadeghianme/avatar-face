import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cx } from "@/lib/cx";

/**
 * One colour to pick, drawn as a round swatch (aria-pressed when it is the
 * one chosen). The colour is data, so it is an inline style, not a class.
 */
export const ColorSwatch = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color" | "aria-label"> & {
    color: string;
    /** The colour's name, its accessible name. */
    label: string;
    selected: boolean;
  }
>(function ColorSwatch({ color, label, selected, className, style, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={selected}
      className={cx(
        "h-9 w-9 rounded-full border-2",
        selected ? "border-brand-600 ring-2 ring-brand-300" : "border-gray-300 dark:border-line",
        className
      )}
      style={{ ...style, backgroundColor: color }}
      {...rest}
    />
  );
});
