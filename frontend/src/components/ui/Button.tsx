import { forwardRef, type ButtonHTMLAttributes } from "react";

import { buttonClass, pressState, type ButtonLook } from "@/components/ui/button-styles";
import { renderIcon, type IconLike } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { cx } from "@/lib/cx";

export type { ButtonSize, ButtonVariant } from "@/components/ui/button-styles";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonLook {
  /** Busy: a spinner where the icon is, and no second press. */
  loading?: boolean;
  /** Before the words. */
  icon?: IconLike;
  /** After the words. */
  iconEnd?: IconLike;
  /** The icons' size; 16px by default. */
  iconClassName?: string;
}

/**
 * The button. `variant` is what it is (primary: the one action a view is
 * for; secondary: the rest; danger; ghost; contrast; overlay, on a
 * picture; link and text, in a line of words), `size` how much room it
 * takes (xs … xl, docs/frontend-ui.md); under a finger every one is 44px
 * tall (index.css). `type` is "button" unless said otherwise: a form's
 * submit says `type="submit"`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    fullWidth,
    loading = false,
    icon,
    iconEnd,
    iconClassName = "h-4 w-4",
    type = "button",
    disabled,
    className,
    children,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(buttonClass({ variant, size, fullWidth }), className)}
      {...pressState({ disabled, loading })}
      {...rest}
    >
      {loading ? <Spinner className={iconClassName} /> : renderIcon(icon, iconClassName)}
      {children}
      {renderIcon(iconEnd, iconClassName)}
    </button>
  );
});
