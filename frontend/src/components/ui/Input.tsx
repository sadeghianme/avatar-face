import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { useFieldControl } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

const ICON = {
  // The sign-in form's 44px fields.
  md: { icon: "start-3.5 h-[18px] w-[18px]", input: "ps-10" },
  // A search box.
  sm: { icon: "start-3 h-4 w-4", input: "ps-9" },
} as const;

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** An icon inside the field, at its start. */
  icon?: IconName;
  iconSize?: keyof typeof ICON;
  /** Something inside the field, at its end (show the password). */
  end?: ReactNode;
  /** The box around the field when it has an icon or an end. */
  wrapperClassName?: string;
}

/**
 * A text field (`.input`): 44px tall and 16px text under a finger, where
 * iOS would otherwise zoom into it. Inside a Field it is labelled, hinted
 * and marked invalid by it.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, iconSize = "md", end, wrapperClassName, className, ...props },
  ref
) {
  const control = useFieldControl(props);
  const input = (
    <input ref={ref} {...props} {...control} className={cx("input", icon && ICON[iconSize].input, className)} />
  );
  if (!icon && !end) return input;
  return (
    <div className={cx("relative", wrapperClassName)}>
      {icon && (
        <Icon
          name={icon}
          className={cx("pointer-events-none absolute top-1/2 -translate-y-1/2 text-gray-400", ICON[iconSize].icon)}
        />
      )}
      {input}
      {end}
    </div>
  );
});
