import { useRef } from "react";

/**
 * A group of custom radio buttons with the keyboard a radio group has:
 * one tab stop (the checked option), arrow keys move the choice and the
 * focus, Home and End go to the ends. Right and Down are "next" in a
 * left-to-right page; in a right-to-left one Left is.
 */
export function useRadioGroup<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (next: T) => void,
  isDisabled: (option: T) => boolean = () => false
) {
  const refs = useRef(new Map<T, HTMLElement | null>());

  const move = (from: T, step: number) => {
    const enabled = values.filter((v) => !isDisabled(v));
    if (enabled.length === 0) return;
    const at = Math.max(0, enabled.indexOf(from));
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next);
    refs.current.get(next)?.focus();
  };

  return (option: T) => ({
    role: "radio" as const,
    "aria-checked": option === value,
    "aria-disabled": isDisabled(option) || undefined,
    tabIndex: option === value ? 0 : -1,
    ref: (el: HTMLElement | null) => {
      refs.current.set(option, el);
    },
    onClick: () => {
      if (!isDisabled(option)) onChange(option);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      const rtl = document.documentElement.dir === "rtl";
      const forward = rtl ? "ArrowLeft" : "ArrowRight";
      const backward = rtl ? "ArrowRight" : "ArrowLeft";
      if (event.key === forward || event.key === "ArrowDown") {
        event.preventDefault();
        move(option, 1);
      } else if (event.key === backward || event.key === "ArrowUp") {
        event.preventDefault();
        move(option, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        move(values[0], 0);
      } else if (event.key === "End") {
        event.preventDefault();
        move(values[values.length - 1], 0);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!isDisabled(option)) onChange(option);
      }
    },
  });
}
