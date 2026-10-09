import { forwardRef, type HTMLAttributes } from "react";

import { cx } from "@/lib/cx";

export interface FieldErrorProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "role"> {
  /**
   * true (the default): an error that answers something the member did (a
   * refused save, a failed upload), announced as it appears (role="alert").
   * false: one that is part of what the page shows (why a build failed, a
   * job's error in a list), read with the rest of the page, not shouted.
   */
  live?: boolean;
}

/**
 * Error text (`.field-error`): under a field, beside the action it answers,
 * or in a card. Give it an `id` and name it in the control's
 * aria-describedby to tie the two (Field does this for its own error).
 */
export const FieldError = forwardRef<HTMLParagraphElement, FieldErrorProps>(function FieldError(
  { live = true, className, ...rest },
  ref
) {
  return <p ref={ref} role={live ? "alert" : undefined} className={cx("field-error", className)} {...rest} />;
});
