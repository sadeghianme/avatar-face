import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TdHTMLAttributes } from "react";

import { ROW_ACTION, STACK } from "@/components/ui/stackTable";
import { cx } from "@/lib/cx";

/**
 * A table that is a table from `sm` up and a list of stacked rows on a
 * phone (stackTable.ts): the row's lead cell takes the whole first line,
 * cut short; the rest share the next; the end cell keeps its action at the
 * end of the line. API keys, members, invitations.
 */
export function StackTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <table className={cx(STACK.table, className)}>
      <tbody className={STACK.body}>{children}</tbody>
    </table>
  );
}

/** A row, with a hairline under it (not under the last). */
export function StackRow({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cx(STACK.row, "border-b border-gray-100 last:border-0 dark:border-line", className)} {...rest} />
  );
}

/** lead: the row's name · cell: the rest · end: its action. */
export function StackCell({
  kind = "cell",
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { kind?: "lead" | "cell" | "end" }) {
  return <td className={cx(STACK[kind], className)} {...rest} />;
}

/**
 * A row's quiet text action (Revoke, Delete, Copy): words, underlined on
 * hover, 44px under a finger. danger is red; brand, the link colour.
 */
export function TableAction({
  tone = "danger",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "danger" | "brand" }) {
  return (
    <button
      type={type}
      className={cx(tone === "danger" ? "text-red-600" : "text-brand-600", "hover:underline", ROW_ACTION, className)}
      {...rest}
    />
  );
}
