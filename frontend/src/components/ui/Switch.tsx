import { type ButtonHTMLAttributes, forwardRef } from "react";

import { switchClasses, type SwitchSize } from "@/components/ui/switch-styles";
import { cx } from "@/lib/cx";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "children"> {
  checked: boolean;
  /** Called with the new state when pressed. */
  onChange: (checked: boolean) => void;
  size?: SwitchSize;
}

/**
 * An on/off switch (role="switch"). Name it with `aria-label` or
 * `aria-labelledby`. A 64×44 tap area around the track (switch-styles.ts).
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, size = "md", className, onClick, ...rest },
  ref
) {
  const look = switchClasses(checked, size);
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!checked);
      }}
      className={cx(look.track, className)}
      {...rest}
    >
      <span aria-hidden="true" className={look.thumb} />
    </button>
  );
});
