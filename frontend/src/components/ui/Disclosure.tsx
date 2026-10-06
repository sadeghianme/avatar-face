import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/**
 * Folding sections: a long column of settings read as a table of contents
 * first (the avatar page's Look, Publish & share, Advanced).
 *
 * A `Disclosure` is a card that folds: one row (its icon, its name, one line
 * of what it is set to, a chevron), the body under it. Folded, the body
 * stays mounted and is only hidden — a mouth kit it follows keeps running,
 * a slider keeps its draft. Whether it is open is the caller's (`open`,
 * `onToggle`), so a page can remember it or open one from elsewhere.
 * A `DisclosureGroup` puts an eyebrow over a run of them.
 */
export function DisclosureGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="mt-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
        {label}
      </p>
      {children}
    </div>
  );
}

export function Disclosure({
  id,
  icon,
  title,
  summary,
  open,
  onToggle,
  className,
  children,
}: {
  /** Prefix of the heading's and the body's ids. */
  id: string;
  icon?: IconName;
  title: string;
  /** One line of what the section holds or is set to, shown folded or not. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-section-title`;
  const bodyId = `${id}-section`;
  return (
    <section className={cx("card p-0", className)} aria-labelledby={headingId}>
      <h2 id={headingId}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className={cx(
            "flex min-h-[52px] w-full items-center gap-3 px-4 text-start transition-colors hover:bg-black/[0.02]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
            "dark:hover:bg-white/[0.03]",
            open ? "rounded-t-2xl" : "rounded-2xl"
          )}
        >
          {icon && (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
              <Icon name={icon} className="h-4 w-4" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
            {summary && <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{summary}</span>}
          </span>
          <Icon
            name="chevron"
            className={cx(
              "h-4 w-4 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none rtl:-scale-x-100",
              open && "rotate-90"
            )}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="border-t border-gray-100 px-4 pb-4 pt-4 dark:border-white/[0.07]">
        {children}
      </div>
    </section>
  );
}
