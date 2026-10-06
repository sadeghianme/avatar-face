import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "@/lib/cx";

/**
 * A file input that is never seen: a Button opens it (`ref.current.click()`)
 * and its onChange takes the file. `srOnly` keeps it in the accessibility
 * tree (and droppable) instead of removing it from layout.
 */
export const FileInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { srOnly?: boolean }
>(function FileInput({ srOnly = false, className, ...props }, ref) {
  return <input ref={ref} type="file" className={cx(srOnly ? "sr-only" : "hidden", className)} {...props} />;
});
