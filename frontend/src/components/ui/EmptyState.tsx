import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/**
 * Nothing here yet, and what to do about it: an icon, a title, a line, an
 * action. `dashed`: a place waiting to be filled (no avatars at all) ·
 * `card`: a list that is empty for now (no match for a search).
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  variant = "card",
  className,
}: {
  icon: IconName;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  variant?: "dashed" | "card";
  className?: string;
}) {
  const dashed = variant === "dashed";
  return (
    <div
      className={cx(
        "rounded-2xl text-center",
        dashed
          ? "border border-dashed border-gray-300 bg-gray-50/50 px-6 py-20 dark:border-gray-700 dark:bg-white/[0.025]"
          : "border border-gray-200 bg-white px-6 py-16 shadow-sm dark:border-line dark:bg-panel dark:shadow-none",
        className
      )}
    >
      <span
        className={cx(
          "mx-auto grid place-items-center rounded-2xl",
          dashed
            ? "h-14 w-14 bg-white text-brand-600 shadow-sm dark:bg-white/[0.07] dark:text-brand-300 dark:shadow-none"
            : "h-12 w-12 bg-gray-100 text-gray-400 dark:bg-white/[0.06]"
        )}
      >
        <Icon name={icon} className={dashed ? "h-7 w-7" : "h-5 w-5"} strokeWidth={dashed ? 1.4 : 1.6} />
      </span>
      <h3 className={dashed ? "mt-5 text-lg font-semibold tracking-[-0.02em]" : "mt-4 text-base font-semibold"}>
        {title}
      </h3>
      {body && (
        <p
          className={
            dashed
              ? "mx-auto mt-2 max-w-sm text-sm leading-relaxed text-gray-500 dark:text-gray-400"
              : "mt-1.5 text-sm text-gray-500 dark:text-gray-400"
          }
        >
          {body}
        </p>
      )}
      {action && <div className={dashed ? "mt-6" : "mt-5"}>{action}</div>}
    </div>
  );
}
