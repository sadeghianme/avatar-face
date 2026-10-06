import type { HTMLAttributes } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/**
 * neutral, muted (standard, not made for this avatar), success, warning,
 * danger, brand (what an AI made or changed: the disclosure every visitor
 * gets too). Component classes (`.badge-*`), so a className can still
 * change one.
 */
export type BadgeTone = "neutral" | "muted" | "success" | "warning" | "danger" | "brand";

// Whole class names, so Tailwind finds them (it keeps a component class only where it sees it used).
const TONE: Record<BadgeTone, string> = {
  neutral: "badge-neutral",
  muted: "badge-muted",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  brand: "badge-brand",
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
