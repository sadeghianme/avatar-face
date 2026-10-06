import { useId, type InputHTMLAttributes, type ReactNode } from "react";

import { RangeInput } from "@/components/ui/RangeInput";
import { cx } from "@/lib/cx";

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  /** The value as shown beside the label; two decimals by default. */
  readout?: ReactNode;
  /** How the readout looks (a word rather than a number reads quieter). */
  readoutClassName?: string;
  /** default: a field's label over it · compact: one small line (tuning). */
  look?: "default" | "compact";
  /** The box around label and range. */
  className?: string;
}

/**
 * A labelled slider with its value read out at the end of the label's row
 * (the mouth's and the framing's settings, the animation tuning).
 */
export function Slider({
  label,
  value,
  onChange,
  readout,
  readoutClassName,
  look = "default",
  id,
  className,
  ...props
}: SliderProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const shown = readout ?? value.toFixed(2);
  return (
    <div className={className}>
      {look === "compact" ? (
        <div className="mb-1 flex justify-between text-xs">
          <label htmlFor={inputId} className="text-gray-600 dark:text-gray-300">
            {label}
          </label>
          <span className={cx("tabular-nums text-gray-400", readoutClassName)}>{shown}</span>
        </div>
      ) : (
        <label className="label flex justify-between gap-2" htmlFor={inputId}>
          <span>{label}</span>
          <span className={readoutClassName ?? "font-mono tabular-nums"}>{shown}</span>
        </label>
      )}
      <RangeInput id={inputId} value={value} onChange={(event) => onChange(Number(event.target.value))} {...props} />
    </div>
  );
}
