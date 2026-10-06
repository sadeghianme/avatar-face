import { Card } from "@/components/ui/Card";
import { Icon, type IconName } from "@/components/ui/Icon";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { cx } from "@/lib/cx";

const TONES = {
  neutral: "bg-gray-100 text-gray-700 dark:bg-white/[0.07] dark:text-gray-200",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
};

/** One number of the library's overview: its label, the number, a line, an optional bar. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone,
  progress,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: IconName;
  tone: keyof typeof TONES;
  /** 0–100: a bar under the number (the speech allowance used). */
  progress?: number;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{label}</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums tracking-[-0.04em] text-gray-950 sm:text-3xl dark:text-white">
            {value}
          </p>
        </div>
        <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl sm:h-10 sm:w-10", TONES[tone])}>
          <Icon name={icon} className="h-[18px] w-[18px] sm:h-5 sm:w-5" strokeWidth={1.7} />
        </span>
      </div>
      {progress !== undefined && (
        <ProgressBar
          value={progress}
          label={label}
          className="mt-4 h-1.5 bg-gray-100 dark:bg-white/[0.07]"
          barClassName="rounded-full bg-brand-500"
        />
      )}
      <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{hint}</p>
    </Card>
  );
}
