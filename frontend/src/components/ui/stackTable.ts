/**
 * A table that is a table from `sm` up and a list of stacked rows on a
 * phone: each row wraps its cells (the first takes the whole line, the
 * rest share the next), so a long email or a list of domains never pushes
 * the page sideways. From `sm` up the classes give back exactly the
 * desktop table (cells padded px-5 py-3).
 *
 * <table className={STACK.table}><tbody className={STACK.body}>
 *   <tr className={`${STACK.row} border-b …`}>
 *     <td className={STACK.lead}>…</td><td className={STACK.cell}>…</td>
 *     <td className={STACK.end}>…</td>
 */
export const STACK = {
  table: "block w-full text-sm sm:table",
  body: "block sm:table-row-group",
  row: "flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:table-row sm:p-0",
  /** The row's name: the whole first line on a phone, cut short there. */
  lead: "w-full min-w-0 max-sm:[&>*]:truncate sm:w-auto sm:px-5 sm:py-3",
  cell: "min-w-0 sm:px-5 sm:py-3",
  /** The row's action, at the end of the line on a phone too. */
  end: "ms-auto sm:ms-0 sm:px-5 sm:py-3 sm:text-end",
} as const;

/** A quiet text action in a row (Delete, Revoke, Copy): 44px under a finger. */
export const ROW_ACTION = "coarse:inline-flex coarse:min-h-11 coarse:items-center coarse:px-2";
