import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "@/lib/cx";

/**
 * A bare range input (`.slider`, the brand accent; 44px tall under a finger,
 * index.css). Slider is the labelled one; this is for a range that is its
 * own picture (the before/after divider).
 */
export const RangeInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function RangeInput({ className, ...props }, ref) {
    return <input ref={ref} type="range" className={cx("slider", className)} {...props} />;
  }
);
