import { cx } from "@/lib/cx";

/**
 * How much of something is used or done, 0–100, as a bar (`.progress`):
 * an allowance, a stage. The track's height and the bar's colour are the
 * caller's to change (`className`, `barClassName`).
 */
export function ProgressBar({
  value,
  label,
  className,
  barClassName,
}: {
  value: number;
  /** Its accessible name (the bar is a progressbar to a screen reader). */
  label?: string;
  className?: string;
  barClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cx("progress", className)}
    >
      <div className={cx("progress-bar", barClassName)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
