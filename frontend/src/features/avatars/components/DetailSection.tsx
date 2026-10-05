import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";

/**
 * The avatar page's settings column, in sections.
 *
 * Beside the preview, every setting of an avatar is a long column: the
 * mouth alone is a screen of controls. Each panel is a card that folds
 * (one row: its icon, its name, one line of what it is set to, a
 * chevron), under an eyebrow that names its group — Look, Publish &
 * share, Advanced — so the column reads as a table of contents before it
 * is read as controls. A folded panel stays mounted, only hidden: a mouth
 * kit it follows keeps running, a slider keeps its draft, and the preview
 * keeps answering the framing panel's drag.
 */
export function SectionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="mt-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
        {label}
      </p>
      {children}
    </div>
  );
}

export function DetailSection({
  id,
  icon,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  /** One line of what the section holds or is set to, shown folded or not. */
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const headingId = `${id}-section-title`;
  const bodyId = `${id}-section`;
  return (
    <section className="card p-0" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className={`flex min-h-[52px] w-full items-center gap-3 px-4 text-start transition-colors hover:bg-black/[0.02]
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500
            dark:hover:bg-white/[0.03] ${open ? "rounded-t-2xl" : "rounded-2xl"}`}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
            <Icon name={icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
            {summary && (
              <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{summary}</span>
            )}
          </span>
          <Icon
            name="chevron"
            className={`h-4 w-4 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none ${
              open ? "rotate-90" : ""
            } rtl:-scale-x-100`}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="border-t border-gray-100 px-4 pb-4 pt-4 dark:border-white/[0.07]">
        {children}
      </div>
    </section>
  );
}
