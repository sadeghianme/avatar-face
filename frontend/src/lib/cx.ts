/**
 * Class names joined, the falsy ones dropped:
 * `cx("card", open && "p-0", undefined)` is `"card p-0"` or `"card"`.
 *
 * No merging: two utilities for the same property both stay, and the
 * stylesheet decides. That is why the UI kit's looks are component classes
 * (index.css): a utility passed in `className` always beats them.
 */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(" ");
}
