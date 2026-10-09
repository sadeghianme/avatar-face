/**
 * The keyboard of a radio group or a tab list, as rules: one tab stop (the
 * chosen item), the arrows move the choice and the focus, Home and End go
 * to the ends, disabled items are stepped over. Right and Down are "next"
 * in a left-to-right page; in a right-to-left one Left is. Framework-free,
 * so `npm test` checks it (useRadioGroup applies it).
 */

/** What a key does: a step, a jump to an end, choosing the focused item. */
export type RovingMove = { step: 1 | -1 } | { to: "first" | "last" } | { choose: true } | null;

export function rovingMove(key: string, rtl: boolean): RovingMove {
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  if (key === forward || key === "ArrowDown") return { step: 1 };
  if (key === backward || key === "ArrowUp") return { step: -1 };
  if (key === "Home") return { to: "first" };
  if (key === "End") return { to: "last" };
  if (key === " " || key === "Enter") return { choose: true };
  return null;
}

/**
 * What a key does in an open menu (the WAI-ARIA menu pattern, MenuButton):
 * Down and Up step through the items and wrap, Home and End go to the
 * ends, Enter and Space choose the focused item, Escape and Tab close the
 * menu. A menu is a vertical list, so Left and Right do nothing (it has no
 * submenus), whatever the page's direction. Anything else is null: a
 * printable key is the type-ahead's (typeaheadTarget).
 */
export type MenuMove =
  { step: 1 | -1 } | { to: "first" | "last" } | { choose: true } | { close: "escape" | "tab" } | null;

export function menuMove(key: string): MenuMove {
  if (key === "ArrowDown") return { step: 1 };
  if (key === "ArrowUp") return { step: -1 };
  if (key === "Home") return { to: "first" };
  if (key === "End") return { to: "last" };
  if (key === " " || key === "Enter") return { choose: true };
  if (key === "Escape") return { close: "escape" };
  if (key === "Tab") return { close: "tab" };
  return null;
}

/**
 * The type-ahead: the item to focus, by index, for what was `typed` in
 * quick succession while the item at `from` had the focus (-1: none);
 * undefined when no label starts with it. Case and accents do not count.
 * One letter, or the same letter again and again, goes to the next item
 * after `from` that starts with it, cycling through them; a word goes to
 * the first item from `from` on that starts with it, so the item being
 * spelled keeps the focus. Both wrap at the end.
 */
export function typeaheadTarget(labels: readonly string[], from: number, typed: string): number | undefined {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase();
  const text = fold(typed);
  const n = labels.length;
  if (!text || n === 0) return undefined;
  const cycling = [...text].every((c) => c === text[0]);
  const query = cycling ? text[0] : text;
  const start = cycling || from < 0 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const at = (((start + k) % n) + n) % n;
    if (fold(labels[at]).startsWith(query)) return at;
  }
  return undefined;
}

/**
 * The item a move lands on from `from`, among the enabled ones, wrapping
 * at the ends; undefined when every item is disabled.
 */
export function rovingTarget<T>(
  values: readonly T[],
  from: T,
  move: { step: 1 | -1 } | { to: "first" | "last" },
  isDisabled: (value: T) => boolean = () => false
): T | undefined {
  const enabled = values.filter((v) => !isDisabled(v));
  if (enabled.length === 0) return undefined;
  if ("to" in move) return move.to === "first" ? enabled[0] : enabled[enabled.length - 1];
  const at = Math.max(0, enabled.indexOf(from));
  return enabled[(at + move.step + enabled.length) % enabled.length];
}
