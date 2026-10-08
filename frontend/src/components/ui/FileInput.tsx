import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "@/lib/cx";

/**
 * A file input that is never seen: a Button opens it (`ref.current.click()`)
 * and its onChange takes the file. Hidden (the `hidden` attribute: out of
 * the page and of the accessibility tree, the button being its face), or
 * `srOnly`: kept in the accessibility tree (and droppable), out of sight.
 */
export const FileInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { srOnly?: boolean }
>(function FileInput({ srOnly = false, className, ...props }, ref) {
  return <input ref={ref} type="file" hidden={!srOnly} className={cx(srOnly && "sr-only", className)} {...props} />;
});
