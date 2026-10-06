import { cx } from "@/lib/cx";

/**
 * How much of something is used or done, 0–100, as a bar (`.progress`):
 * an allowance, a job. `null` is "under way, amount unknown": a third of
 * the track, pulsing. The track's height and the bar's colour are the
 * caller's to change (`className`, `barClassName`).
 */
export function ProgressBar({
  value,
  label,
  className,
  barClassName,
}: {
  value: number | null;
  /** Its accessible name (the bar is a progressbar to a screen reader). */
  label?: string;
  className?: string;
  barClassName?: string;
}) {
  const clamped = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped === null ? undefined : Math.round(clamped)}
      className={cx("progress", className)}
    >
      <div
        className={cx("progress-bar", clamped === null && "w-1/3 animate-pulse", barClassName)}
        style={clamped === null ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
