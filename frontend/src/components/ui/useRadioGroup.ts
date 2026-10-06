import { type KeyboardEvent, useRef } from "react";

import { rovingMove, rovingTarget } from "@/components/ui/roving";

/**
 * A group of custom radio buttons (or tabs, `role: "tab"`) with the
 * keyboard a radio group has (roving.ts): one tab stop (the checked
 * option), arrow keys move the choice and the focus, Home and End go to
 * the ends. Spread the returned props on each option:
 * `<ChoiceCard {...radio(option)}>`. SegmentedControl and Tabs use it.
 */
export function useRadioGroup<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (next: T) => void,
  isDisabled: (option: T) => boolean = () => false,
  role: "radio" | "tab" = "radio"
) {
  const refs = useRef(new Map<T, HTMLElement | null>());

  const go = (next: T | undefined) => {
    if (next === undefined) return;
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (option: T) => ({
    role,
    ...(role === "tab" ? { "aria-selected": option === value } : { "aria-checked": option === value }),
    "aria-disabled": isDisabled(option) || undefined,
    tabIndex: option === value ? 0 : -1,
    ref: (el: HTMLElement | null) => {
      refs.current.set(option, el);
    },
    onClick: () => {
      if (!isDisabled(option)) onChange(option);
    },
    onKeyDown: (event: KeyboardEvent) => {
      const move = rovingMove(event.key, document.documentElement.dir === "rtl");
      if (!move) return;
      event.preventDefault();
      if ("choose" in move) {
        if (!isDisabled(option)) onChange(option);
      } else {
        go(rovingTarget(values, option, move, isDisabled));
      }
    },
  });
}
