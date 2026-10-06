import { forwardRef, type SelectHTMLAttributes } from "react";

import { useFieldControl } from "@/components/ui/Field";
import { cx } from "@/lib/cx";

/** A native select (`.input`); see Input. The options are its children. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref
) {
  const control = useFieldControl(props);
  return <select ref={ref} {...props} {...control} className={cx("input", className)} />;
});
