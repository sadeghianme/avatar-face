import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cx } from "@/lib/cx";

export interface ChoiceCardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Whether it is the one chosen: styles the tile. The ARIA (aria-checked
   *  from useRadioGroup, or aria-pressed) is the caller's. */
  selected?: boolean;
  /**
   * tile: a bordered option with its words and a line under them (the
   * mouth's Classic / Photographic) · custom: the caller draws the whole
   * card (the wizard's pictures); the kit gives it a button's semantics,
   * keyboard and focus.
   */
  look?: "tile" | "custom";
}

/**
 * One option of a choice drawn as a card. In a group, spread
 * `useRadioGroup`'s props on it (role="radio", one tab stop, arrows).
 */
export const ChoiceCard = forwardRef<HTMLButtonElement, ChoiceCardProps>(function ChoiceCard(
  { selected = false, look = "tile", type = "button", className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        look === "tile" && "choice-tile",
        look === "tile" && (selected ? "choice-tile-on" : "choice-tile-off"),
        className
      )}
      {...rest}
    />
  );
});
