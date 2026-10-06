import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cx } from "@/lib/cx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** The words beside the box; the whole row is the label. */
  label: ReactNode;
  /** A line under the words. */
  description?: ReactNode;
  /** sm 16px (beside a setting) · md 20px (a statement to agree to). */
  size?: "sm" | "md";
  /** The row: spacing, text size, a border above it. */
  className?: string;
  /** The box itself (its accent). */
  inputClassName?: string;
}

/**
 * A checkbox with its words, the whole row clickable (`.check-row`): 44px
 * tall under a finger.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, size = "sm", className, inputClassName, ...props },
  ref
) {
  return (
    <label className={cx("check-row", className)}>
      <input
        ref={ref}
        type="checkbox"
        className={cx("checkbox", size === "md" && "h-5 w-5", inputClassName)}
        {...props}
      />
      {description ? (
        <span>
          {label}
          <span className="block text-xs text-gray-500 dark:text-gray-400">{description}</span>
        </span>
      ) : (
        label
      )}
    </label>
  );
});
