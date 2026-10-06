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
