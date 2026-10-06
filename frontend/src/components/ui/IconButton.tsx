import { forwardRef, type ButtonHTMLAttributes } from "react";

import { iconButtonClass, type IconButtonVariant } from "@/components/ui/button-styles";
import { renderIcon, type IconLike } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  /** What it does, in words: its accessible name. Required — the icon
   *  alone says nothing to a screen reader. */
  label: string;
  icon: IconLike;
  /** The icon's size; 18px by default (the header's). */
  iconClassName?: string;
  /** Also show `label` as the hover tooltip. */
  tooltip?: boolean;
  variant?: IconButtonVariant;
}

/**
 * A button that is one icon: the header's theme and language, a row's
 * delete, the stage's fullscreen. At least 44×44 under a finger
 * (index.css), however small it draws for a mouse.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, iconClassName = "h-[18px] w-[18px]", tooltip = false, variant, type = "button", className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={tooltip ? label : undefined}
      className={cx(iconButtonClass(variant), className)}
      {...rest}
    >
      {renderIcon(icon, iconClassName)}
    </button>
  );
});
