import type { HTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

export type BannerTone = "info" | "success" | "warning" | "danger" | "brand";

const CARD_BORDER: Record<BannerTone, string> = {
  info: "",
  success: "",
  brand: "",
  warning: "border-amber-300/60 dark:border-amber-500/30",
  danger: "border-red-200 dark:border-red-900",
};

const ICON_COLOUR: Record<BannerTone, string> = {
  info: "text-gray-400",
  success: "text-emerald-600 dark:text-emerald-400",
  brand: "text-brand-600 dark:text-brand-300",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

const SOFT: Record<BannerTone, string> = {
  info: "bg-gray-50 text-gray-700 ring-black/[0.06] dark:bg-white/[0.04] dark:text-gray-300 dark:ring-white/10",
  success:
    "bg-emerald-50 text-emerald-800 ring-emerald-600/10 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  brand: "bg-brand-50 text-brand-800 ring-brand-600/10 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/20",
  warning:
    "bg-amber-50 text-amber-800 ring-amber-600/10 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/20",
  danger: "bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** A section when it is labelled by its own title (aria-labelledby). */
  as?: "div" | "section";
  tone?: BannerTone;
  /**
   * card: a slim card strip with the state's border, beside other cards
   * (the publish state, the finish notice) · soft: a tinted box inside a
   * form or card (a refused sign-in, a stalled build).
   */
  appearance?: "card" | "soft";
  icon?: IconName;
  /** A strong first line; the children then read as its explanation. */
  title?: ReactNode;
  /** At the end of the row (card) or under the words (soft). */
  actions?: ReactNode;
  /** Under everything, the width of the banner (an error from an action). */
  footer?: ReactNode;
}

/**
 * A state worth reading: info, success, warning, danger, brand. Give it
 * role="status" for news that arrives on its own, role="alert" for an
 * error that answers an action.
 */
export function Banner({
  as: Element = "div",
  tone = "info",
  appearance = "card",
  icon,
  title,
  actions,
  footer,
  className,
  children,
  ...rest
}: BannerProps) {
  const body = title ? (
    <div className="min-w-0">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-0.5 text-xs leading-snug text-gray-500 dark:text-gray-400">{children}</div>}
    </div>
  ) : (
    <div className="min-w-0">{children}</div>
  );

  if (appearance === "soft") {
    return (
      <Element
        className={cx("flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[14px] ring-1", SOFT[tone], className)}
        {...rest}
      >
        {icon && <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />}
        <div className="min-w-0 flex-1">
          {children}
          {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
          {footer}
        </div>
      </Element>
    );
  }

  return (
    <Element className={cx("card px-4 py-3", CARD_BORDER[tone], className)} {...rest}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
          {icon && <Icon name={icon} className={cx("mt-0.5 h-4 w-4 shrink-0", ICON_COLOUR[tone])} />}
          {body}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {footer}
    </Element>
  );
}
