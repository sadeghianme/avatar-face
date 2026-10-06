import type { HTMLAttributes } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "brand";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  // What an AI made or changed: the disclosure every visitor gets too.
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: IconName;
}

/** A small rounded label for a state or a fact (`.badge`): Ready, Not live, AI-edited. */
export function Badge({ tone = "neutral", icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("badge", TONE[tone], className)} {...rest}>
      {icon && <Icon name={icon} className="h-3.5 w-3.5 shrink-0" />}
      {children}
    </span>
  );
}
