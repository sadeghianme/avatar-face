import { forwardRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Input, type InputProps } from "@/components/ui/Input";
import { cx } from "@/lib/cx";

/**
 * A password field with its own show/hide eye at the end (pressed: shown).
 * The words for the eye are the caller's, translated.
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type" | "end"> & { showLabel: string; hideLabel: string }
>(function PasswordInput({ showLabel, hideLabel, className, ...props }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      ref={ref}
      type={shown ? "text" : "password"}
      className={cx("pe-11", className)}
      {...props}
      end={
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? hideLabel : showLabel}
          aria-pressed={shown}
          className="absolute inset-y-0 end-0 grid w-11 place-items-center rounded-e-lg text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 dark:hover:text-gray-200"
        >
          <Icon name={shown ? "eyeOff" : "eye"} className="h-[18px] w-[18px]" />
        </button>
      }
    />
  );
});
