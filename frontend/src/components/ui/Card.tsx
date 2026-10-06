import { type ElementType, forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cx } from "@/lib/cx";

export type CardTone = "default" | "warning" | "danger" | "success";
export type CardPadding = "md" | "sm" | "none";

const TONE: Record<CardTone, string> = {
  default: "",
  // Needs a look: a first build not yet published, a quality note.
  warning: "border-amber-300/60 dark:border-amber-500/30",
  danger: "border-red-200 dark:border-red-900",
  // Done, and worth reading once (a key shown a single time).
  success: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20",
};

const PADDING: Record<CardPadding, string> = { md: "", sm: "px-4 py-3", none: "p-0" };

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** The element: a section when it has a heading of its own, a form… */
  as?: "div" | "section" | "form" | "article" | "aside";
  tone?: CardTone;
  /** md 20px (the default) · sm a slim strip · none, for a table. */
  padding?: CardPadding;
}

/** A surface: white on the page, a panel in dark (`.card`). */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as = "div", tone = "default", padding = "md", className, ...rest },
  ref
) {
  const Element = as as ElementType;
  return <Element ref={ref} className={cx("card", PADDING[padding], TONE[tone], className)} {...rest} />;
});

/**
 * A card's heading: its title, a line under it, and actions at the end of
 * the row. The spacing below it is the caller's (`className="mb-4"`).
 */
export function CardHeader({
  title,
  description,
  actions,
  as: Heading = "h2",
  id,
  descriptionId,
  className,
  titleClassName = "font-medium",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: "h2" | "h3";
  /** The heading's id, for a card labelled by it. */
  id?: string;
  descriptionId?: string;
  className?: string;
  titleClassName?: string;
}) {
  const text = (
    <>
      <Heading id={id} className={titleClassName}>
        {title}
      </Heading>
      {description && (
        <p id={descriptionId} className="mt-1 text-[13px] text-gray-500 max-lg:text-sm dark:text-gray-400">
          {description}
        </p>
      )}
    </>
  );
  if (!actions) return <div className={className}>{text}</div>;
  return (
    <div className={cx("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">{text}</div>
      {actions}
    </div>
  );
}
