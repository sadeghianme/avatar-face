import { forwardRef, type TextareaHTMLAttributes } from "react";

import { useFieldControl } from "@/components/ui/Field";
import { cx } from "@/lib/cx";

/** A multi-line field (`.input`); see Input. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref
) {
  const control = useFieldControl(props);
  return <textarea ref={ref} {...props} {...control} className={cx("input", className)} />;
});
