import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "@/lib/cx";

/** The system colour picker, as a small swatch-sized well. Name it with aria-label. */
export const ColorInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function ColorInput({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="color"
        className={cx(
          "h-9 w-12 cursor-pointer rounded border border-gray-300 bg-transparent p-0.5 dark:border-line",
          className
        )}
        {...props}
      />
    );
  }
);
